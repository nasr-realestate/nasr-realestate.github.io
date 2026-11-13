#!/usr/bin/env python3
"""Read an exported address book (.vcf) into a phone-number -> display-name map.

Stdlib only, read-only, no network. The backup itself carries no contact names on
modern WhatsApp, so without this map every chat title is a bare number and the CRM
(which identifies conversations by contact name) cannot match anything.
"""
from __future__ import annotations

import quopri
import re
from pathlib import Path

DIGITS = re.compile(r"\D+")
DEFAULT_COUNTRY = "20"  # Egypt; override with country_code in config.json


def normalize_number(raw: str, country_code: str = DEFAULT_COUNTRY) -> str:
    """Return a comparable international digit string, or "" when unusable."""
    digits = DIGITS.sub("", str(raw or ""))
    if digits.startswith("00"):
        digits = digits[2:]
    cc = DIGITS.sub("", country_code) or DEFAULT_COUNTRY
    if digits.startswith("0") and len(digits) >= 10:
        digits = cc + digits[1:]
    if len(digits) < 8 or len(digits) > 15:
        return ""
    return digits


def _decode(value: str, params: str) -> str:
    upper = params.upper()
    if "QUOTED-PRINTABLE" in upper:
        charset = "utf-8"
        match = re.search(r"CHARSET=([^;:]+)", params, re.I)
        if match:
            charset = match.group(1).strip('"')
        try:
            return quopri.decodestring(value.encode("utf-8", "surrogateescape")).decode(charset, "replace")
        except (LookupError, ValueError):
            return value
    return value


def parse_vcf(path: Path, country_code: str = DEFAULT_COUNTRY) -> tuple[dict[str, str], dict]:
    """Return (number -> name, stats). First name wins on a duplicated number."""
    mapping: dict[str, str] = {}
    stats = {"cards": 0, "numbers": 0, "duplicate_numbers": 0, "unnamed": 0}
    name, numbers, field, buffer, params = "", [], "", [], ""

    def flush_field():
        nonlocal name, numbers, field, buffer, params
        if not field:
            return
        value = _decode("".join(buffer), params)
        if field == "FN":
            name = value.strip()
        elif field == "TEL":
            numbers.append(value)
        field, buffer, params = "", [], ""

    def flush_card():
        nonlocal name, numbers
        flush_field()
        if name or numbers:
            stats["cards"] += 1
        clean_name = name.strip()
        if not clean_name:
            stats["unnamed"] += 1
        for raw in numbers:
            number = normalize_number(raw, country_code)
            if not number:
                continue
            stats["numbers"] += 1
            if number in mapping:
                if mapping[number] != clean_name and clean_name:
                    stats["duplicate_numbers"] += 1
            elif clean_name:
                mapping[number] = clean_name
        name, numbers = "", []

    with Path(path).open("r", encoding="utf-8-sig", errors="replace") as handle:
        for line in handle:
            line = line.rstrip("\r\n")
            if line[:1] in (" ", "\t") and field:
                buffer.append(line[1:])
                continue
            flush_field()
            upper = line.upper()
            if upper.startswith("END:VCARD"):
                flush_card()
                continue
            if upper.startswith("BEGIN:VCARD"):
                name, numbers = "", []
                continue
            head, sep, value = line.partition(":")
            if not sep:
                continue
            prop, _, parameters = head.partition(";")
            prop = prop.rsplit(".", 1)[-1].upper()
            if prop in {"FN", "TEL"}:
                field, buffer, params = prop, [value], parameters
    flush_card()
    return mapping, stats


def number_of(jid: str) -> str:
    """Phone part of a WhatsApp JID, dropping any multi-device suffix."""
    return jid.split("@", 1)[0].split(":", 1)[0]


def domain_of(jid: str) -> str:
    return jid.split("@", 1)[1] if "@" in jid else ""
