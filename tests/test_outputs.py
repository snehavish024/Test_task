"""Verifier for the firmware release publisher task."""

from __future__ import annotations

import csv
import json
import re
import subprocess
from pathlib import Path

import duckdb
import pytest

APP = Path("/app")
MANIFEST = APP / "fixtures/build_manifest.csv"
EXPECTED = APP / "reports/publications.expected.txt"
DATABASE = APP / "releases.duckdb"
LEDGER = APP / "distribution-gateway/data/gateway.json"


def expected_bundles() -> list[tuple[str, int, int]]:
    with MANIFEST.open(newline="", encoding="utf-8") as source:
        rows = list(csv.DictReader(source))
    fields = tuple(rows[0])
    distinct = {
        tuple(row[field] for field in fields): row
        for row in rows
    }.values()
    withdrawn = {
        row["supersedes_id"]
        for row in distinct
        if row["record_type"] == "WITHDRAWAL" and row["supersedes_id"]
    }
    totals: dict[str, list[int]] = {}
    for row in distinct:
        if row["record_type"] == "BUILD" and row["entry_id"] not in withdrawn:
            values = totals.setdefault(row["bundle_id"], [0, 0])
            values[0] += 1
            values[1] += int(row["size_bytes"])
    return [(bundle, *totals[bundle]) for bundle in sorted(totals)]


def run_report() -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["npm", "run", "--silent", "report"], cwd=APP, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )


def normalized_output(output: str) -> str:
    return re.sub(r"RECEIPT=[^ ]+", "RECEIPT=<id>", output)


@pytest.fixture(scope="module")
def first_run() -> subprocess.CompletedProcess[str]:
    result = run_report()
    assert result.returncode == 0, result.stderr
    return result


def test_output_matches_golden(first_run: subprocess.CompletedProcess[str]) -> None:
    assert normalized_output(first_run.stdout) == normalized_output(
        EXPECTED.read_text(encoding="utf-8")
    )


def test_duckdb_reconciles_and_persists_receipts(
    first_run: subprocess.CompletedProcess[str],
) -> None:
    assert DATABASE.is_file(), "publisher did not create /app/releases.duckdb"
    connection = duckdb.connect(str(DATABASE), read_only=True)
    try:
        actual = connection.execute(
            "SELECT bundle_id, request_token, publication_id, status, key_id, descriptor "
            "FROM publications ORDER BY bundle_id"
        ).fetchall()
    finally:
        connection.close()

    expected = expected_bundles()
    assert [row[0] for row in actual] == [row[0] for row in expected]
    assert len(actual) == len(expected)
    for row, (bundle_id, artifact_count, total_bytes) in zip(actual, expected):
        assert row[1] == f"token-{bundle_id}"
        assert row[3] == "PUBLISHED"
        assert row[4] == "fw-signing-2026-current"
        assert json.loads(row[5]) == {
            "artifact_count": artifact_count,
            "bundle_id": bundle_id,
            "total_bytes": total_bytes,
        }
        assert row[5] == json.dumps(json.loads(row[5]), sort_keys=True, separators=(",", ":"))


def test_second_run_is_identical_and_does_not_republish(
    first_run: subprocess.CompletedProcess[str],
) -> None:
    before = json.loads(LEDGER.read_text(encoding="utf-8"))
    second_run = run_report()
    assert second_run.returncode == 0, second_run.stderr
    assert second_run.stdout == first_run.stdout
    after = json.loads(LEDGER.read_text(encoding="utf-8"))
    assert after == before
    assert len(after["publications"]) == len(expected_bundles())


def _sign_with(key: Path, cert: Path, descriptor: str, tmp_path: Path) -> str:
    content = tmp_path / "descriptor.json"
    signature = tmp_path / "signature.pem"
    content.write_text(descriptor, encoding="utf-8")
    subprocess.run(
        ["openssl", "cms", "-sign", "-in", str(content), "-signer", str(cert),
         "-inkey", str(key), "-out", str(signature), "-outform", "PEM", "-binary"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    return signature.read_text(encoding="utf-8")


def test_gateway_rejects_revoked_signature(tmp_path: Path) -> None:
    # This verifier-owned request proves the provided gateway still enforces key rotation.
    import urllib.request

    descriptor = '{"artifact_count":1,"bundle_id":"VERIFIER-REVOKED","total_bytes":1}'
    signature = _sign_with(
        APP / "keys/revoked/revoked.key.pem", APP / "keys/revoked/revoked.cert.pem",
        descriptor, tmp_path,
    )
    request = urllib.request.Request(
        "http://127.0.0.1:7070/v1/publications",
        data=json.dumps({"descriptor": descriptor, "signature": signature,
                         "request_token": "verifier-revoked"}).encode(),
        headers={"content-type": "application/json"}, method="POST",
    )
    with pytest.raises(Exception) as error:
        urllib.request.urlopen(request)
    assert "UNTRUSTED_SIGNATURE" in error.value.read().decode()
