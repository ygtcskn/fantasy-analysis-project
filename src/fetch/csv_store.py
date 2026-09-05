"""CSV tables and lossless CSV storage for nested API responses.

HTTP responses are decoded in memory by the clients. No structured values are
encoded into CSV cells: nested data is stored as typed scalar rows instead.
"""
import csv
import os
from pathlib import Path


def write_table(path, rows, columns=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = list(rows)
    fields = list(columns or [])
    fields.extend(sorted({key for row in rows for key in row} - set(fields)))
    if not fields:
        fields = ["id"]
    temp = path.with_suffix(path.suffix + ".tmp")
    try:
        with temp.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            for row in rows:
                if any(isinstance(value, (dict, list, tuple)) for value in row.values()):
                    raise ValueError("CSV cells must be scalar; flatten nested data first.")
                writer.writerow(row)
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def read_table(path):
    with Path(path).open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def scalar_fields(data, prefix=""):
    """Flatten dictionaries into columns; lists live in related/raw CSV tables."""
    result = {}
    if not isinstance(data, dict):
        return {prefix or "value": data} if not isinstance(data, list) else {}
    for key, value in data.items():
        name = f"{prefix}.{key}" if prefix else str(key)
        if isinstance(value, dict):
            result.update(scalar_fields(value, name))
        elif not isinstance(value, list):
            result[name] = value
    return result


def write_tree(path, data):
    """Preserve every response field as node_id,parent_id,key,kind,value rows."""
    rows = []
    def visit(value, parent_id="", key=""):
        node_id = len(rows)
        if isinstance(value, dict):
            kind, scalar = "dict", ""
        elif isinstance(value, list):
            kind, scalar = "list", ""
        elif value is None:
            kind, scalar = "null", ""
        elif isinstance(value, bool):
            kind, scalar = "bool", "true" if value else "false"
        elif isinstance(value, int):
            kind, scalar = "int", str(value)
        elif isinstance(value, float):
            kind, scalar = "float", repr(value)
        elif isinstance(value, str):
            kind, scalar = "str", value
        else:
            raise TypeError(f"Unsupported response value: {type(value).__name__}")
        rows.append({"node_id": node_id, "parent_id": parent_id, "key": key, "kind": kind, "value": scalar})
        children = value.items() if kind == "dict" else enumerate(value) if kind == "list" else []
        for child_key, child in children:
            visit(child, node_id, child_key)
    visit(data)
    write_table(path, rows, ["node_id", "parent_id", "key", "kind", "value"])


def read_tree(path):
    nodes = {}
    root = None
    for row in read_table(path):
        node_id, parent_id = int(row["node_id"]), row["parent_id"]
        kind, value = row["kind"], row["value"]
        if kind == "dict": value = {}
        elif kind == "list": value = []
        elif kind == "null": value = None
        elif kind == "bool": value = value == "true"
        elif kind == "int": value = int(value)
        elif kind == "float": value = float(value)
        elif kind != "str": raise ValueError(f"Unknown CSV node kind: {kind}")
        if node_id in nodes:
            raise ValueError("Duplicate CSV node ID")
        nodes[node_id] = value
        if parent_id == "":
            if len(nodes) != 1: raise ValueError("Multiple CSV roots")
            root = value
        else:
            parent = nodes[int(parent_id)]
            if isinstance(parent, list):
                if int(row["key"]) != len(parent): raise ValueError("Out-of-order list item")
                parent.append(value)
            elif isinstance(parent, dict):
                parent[row["key"]] = value
            else:
                raise ValueError("A scalar node cannot have children")
    if not nodes: raise ValueError("Empty CSV tree")
    return root


def redact(value, secret):
    if isinstance(value, dict): return {k: redact(v, secret) for k, v in value.items()}
    if isinstance(value, list): return [redact(v, secret) for v in value]
    if isinstance(value, str) and secret: return value.replace(secret, "[REDACTED]")
    return value
