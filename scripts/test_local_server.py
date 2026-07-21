#!/usr/bin/env python3
"""Live integration test suite for the local cnbs-mcp-server (Python MCP SDK).

This script drives the server over Streamable HTTP with real API calls to every
live data source (CNBS, World Bank, IMF, OECD, BIS, census, department) plus
cross-source and chained-workflow scenarios. It reuses a single MCP session,
validates each tool's response contract, and reports PASS / WARN / SKIP / FAIL
with a non-zero exit code when any case hard-fails.

Install the SDK:

    pip install "mcp[cli]"

Start the server first:

    npm run build
    node dist/index.js --host 127.0.0.1 --port 12345

Then run:

    python3 scripts/test_local_server.py                 # run the full live suite
    python3 scripts/test_local_server.py --list-only      # just init + list tools
    python3 scripts/test_local_server.py --list-cases     # list registered cases (no server)
    python3 scripts/test_local_server.py --tag world_bank # run only World Bank cases
    python3 scripts/test_local_server.py --only search     # run cases whose name contains "search"
    python3 scripts/test_local_server.py --tag slow        # include slow cases (e.g. end-node crawl)
    python3 scripts/test_local_server.py --json report.json
    python3 scripts/test_local_server.py --tool cnbs_search --arguments '{"keyword":"GDP"}'  # ad-hoc single call
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import traceback
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Optional

if TYPE_CHECKING:  # imported lazily at runtime so --list-cases works without the SDK
    from mcp import ClientSession


# ─── generic serialization helpers ─────────────────────────────────────────
def to_jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    if isinstance(value, dict):
        return {key: to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(item) for item in value]
    return value


def get_field(value: Any, name: str) -> Any:
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


def format_exception(exc: BaseException) -> str:
    exception_group_type = globals().get("BaseExceptionGroup")
    if exception_group_type is not None and isinstance(exc, exception_group_type):
        lines = [f"{type(exc).__name__}: {exc}"]
        for index, child in enumerate(exc.exceptions, start=1):
            lines.append(f"\n--- sub-exception {index}: {type(child).__name__} ---")
            lines.extend(traceback.format_exception(child))
        return "".join(lines).rstrip()
    return "".join(traceback.format_exception(exc)).rstrip()


def dig(obj: Any, *keys: Any) -> Any:
    """Safely navigate nested dict/list structures; returns None on any miss."""
    cur = obj
    for key in keys:
        if isinstance(key, int):
            if isinstance(cur, list) and -len(cur) <= key < len(cur):
                cur = cur[key]
            else:
                return None
        else:
            if isinstance(cur, dict):
                cur = cur.get(key)
            else:
                return None
        if cur is None:
            return None
    return cur


def deep_has_values(obj: Any) -> bool:
    """True if any non-empty list exists anywhere in the structure."""
    if isinstance(obj, list):
        return len(obj) > 0 or any(deep_has_values(item) for item in obj)
    if isinstance(obj, dict):
        return any(deep_has_values(item) for item in obj.values())
    return False


# ─── case control-flow signals ─────────────────────────────────────────────
class CaseSkip(Exception):
    """Case cannot run given current data; not a failure."""


class CaseWarn(Exception):
    """Case reached the server but data was empty/degraded; soft signal."""


class CaseFail(Exception):
    """Case violated the expected contract; hard failure."""


# ─── assertion helpers (operate on jsonable call_tool results) ──────────────
def extract_text(result: Any) -> str:
    content = get_field(result, "content") or []
    parts = []
    for item in content:
        if get_field(item, "type") == "text":
            parts.append(get_field(item, "text") or "")
    return "\n".join(parts)


SOFT_UPSTREAM_ERROR_TYPES = {
    "ACCESS_BLOCKED",
    "RATE_LIMIT",
    "TIMEOUT_ISSUE",
    "NETWORK_ISSUE",
}


def extract_tool_error(result: Any) -> dict:
    sc = get_field(result, "structuredContent")
    if not isinstance(sc, dict):
        return {}
    error = sc.get("error")
    return error if isinstance(error, dict) else {}


def is_soft_upstream_error(error: dict, text: str) -> bool:
    error_type = error.get("type")
    message = str(error.get("message") or text)
    return (
        error_type in SOFT_UPSTREAM_ERROR_TYPES
        or 'Circuit breaker "' in message and " is OPEN - request rejected" in message
    )


def assert_ok(result: Any) -> None:
    if get_field(result, "isError"):
        text = extract_text(result)
        error = extract_tool_error(result)
        if is_soft_upstream_error(error, text):
            error_type = error.get("type") or "UPSTREAM_UNAVAILABLE"
            raise CaseWarn(f"{error_type}: {text[:300]}")
        raise CaseFail(f"tool returned isError=true: {text[:400]}")


def assert_structured(result: Any) -> dict:
    sc = get_field(result, "structuredContent")
    if not isinstance(sc, dict):
        raise CaseFail("missing or non-object structuredContent")
    return sc


def assert_union_shape(sc: dict) -> list:
    """Validate the { results: [{ key, data?, error? }], count } contract."""
    results = sc.get("results")
    if not isinstance(results, list):
        raise CaseFail("union result missing 'results' array")
    if sc.get("count") != len(results):
        raise CaseFail(f"count {sc.get('count')} != len(results) {len(results)}")
    errors = []
    for idx, entry in enumerate(results):
        if not isinstance(entry, dict) or "key" not in entry:
            raise CaseFail(f"union entry #{idx} missing 'key'")
        if "data" not in entry and "error" not in entry:
            raise CaseFail(f"union entry '{entry.get('key')}' has neither data nor error")
        if "error" in entry:
            errors.append(f"{entry['key']}: {entry['error']}")
    if errors and len(errors) == len(results):
        raise CaseWarn("all union entries returned errors: " + "; ".join(errors)[:300])
    return results


# ─── case model ─────────────────────────────────────────────────────────────
@dataclass
class Ctx:
    session: ClientSession

    async def call(self, tool: str, arguments: dict) -> Any:
        result = await self.session.call_tool(tool, arguments)
        return to_jsonable(result)


@dataclass
class Case:
    name: str
    tags: tuple[str, ...]
    run: Callable[[Ctx], Awaitable[Optional[str]]]


Validator = Callable[[dict, Any], Optional[str]]


def tool_case(name: str, tags: list[str], tool: str, arguments: dict,
              validate: Optional[Validator] = None) -> Case:
    """Build a Case that calls one tool, asserts ok+structured, then validates."""

    async def _run(ctx: Ctx) -> Optional[str]:
        result = await ctx.call(tool, arguments)
        assert_ok(result)
        sc = assert_structured(result)
        if validate is not None:
            return validate(sc, result)
        return None

    return Case(name=name, tags=tuple(tags), run=_run)



# ─── per-tool validators ────────────────────────────────────────────────────
def v_cnbs_search(sc: dict, _result: Any) -> Optional[str]:
    results = sc.get("results")
    if not isinstance(results, dict):
        raise CaseFail("cnbs_search 'results' is not an object")
    data = results.get("data")
    if not isinstance(data, list) or not data:
        raise CaseWarn("cnbs_search returned no data rows")
    return f"{len(data)} rows"


def v_snapshot(sc: dict, _result: Any) -> Optional[str]:
    snapshot = sc.get("snapshot")
    if not isinstance(snapshot, list):
        raise CaseFail("economic_snapshot missing 'snapshot' array")
    if sc.get("count") != len(snapshot):
        raise CaseFail("economic_snapshot count mismatch")
    populated = [s for s in snapshot if s.get("value") is not None]
    if not populated:
        raise CaseWarn(f"snapshot has {len(snapshot)} indicators but all values empty")
    return f"{len(populated)}/{len(snapshot)} indicators populated"


def v_quick_query(sc: dict, _result: Any) -> Optional[str]:
    if "series" not in sc and "warning" not in sc and "candidates" not in sc:
        raise CaseFail("quick_query missing series/warning/candidates")
    if sc.get("warning"):
        raise CaseWarn(f"quick_query warning: {str(sc['warning'])[:200]}")
    if not deep_has_values(sc.get("series")):
        raise CaseWarn("quick_query series empty")
    return "series populated"


def v_union(sc: dict, _result: Any) -> Optional[str]:
    results = assert_union_shape(sc)
    return f"{len(results)} union entr{'y' if len(results) == 1 else 'ies'}"


def v_compare(sc: dict, _result: Any) -> Optional[str]:
    for key in ("keyword", "compareType", "comparison", "summary"):
        if key not in sc:
            raise CaseFail(f"cnbs_compare missing '{key}'")
    if sc.get("hint"):
        raise CaseWarn(f"compare hint: {sc['hint']}")
    if not sc.get("summary"):
        raise CaseWarn("compare produced empty summary (no region/period match)")
    return f"{len(sc['summary'])} summary rows"


def v_wrapped_result(sc: dict, _result: Any) -> Optional[str]:
    if "result" not in sc:
        raise CaseFail("missing 'result' field")
    if not deep_has_values(sc.get("result")):
        raise CaseWarn("wrapped result contained no data rows")
    return None


def v_categories(sc: dict, _result: Any) -> Optional[str]:
    cats = sc.get("categories")
    if cats is None:
        raise CaseFail("missing 'categories'")
    if not deep_has_values(cats):
        raise CaseWarn("categories empty")
    return None


def v_has_data(sc: dict, _result: Any) -> Optional[str]:
    if not sc:
        raise CaseFail("empty structuredContent")
    if not deep_has_values(sc):
        raise CaseWarn("response contained no data rows")
    return None


def v_global_compare(sc: dict, _result: Any) -> Optional[str]:
    if "world_bank" not in sc or "imf" not in sc:
        raise CaseFail("global_compare missing world_bank/imf branches")
    warns = []
    for branch in ("world_bank", "imf"):
        value = sc.get(branch)
        if isinstance(value, dict) and "error" in value:
            warns.append(f"{branch}: {str(value['error'])[:120]}")
        elif not deep_has_values(value):
            warns.append(f"{branch}: no data")
    if warns:
        raise CaseWarn("; ".join(warns))
    return "both branches resolved"


# ─── chained workflow cases ─────────────────────────────────────────────────
async def wf_discovery_to_series(ctx: Ctx) -> Optional[str]:
    search = await ctx.call("cnbs_search", {"keyword": "GDP", "pageSize": 10})
    assert_ok(search)
    data = dig(assert_structured(search), "results", "data")
    if not isinstance(data, list) or not data:
        raise CaseSkip("cnbs_search returned no rows; cannot chain")
    first = data[0]
    set_id = first.get("cid")
    metric_id = first.get("indic_id")
    if not set_id:
        raise CaseSkip("search row has no cid (setId)")

    metrics = await ctx.call("cnbs_fetch_metrics", {"setIds": str(set_id)})
    assert_ok(metrics)
    assert_union_shape(assert_structured(metrics))

    if not metric_id:
        raise CaseWarn(f"resolved setId={set_id} but no indic_id to fetch series")
    series = await ctx.call("cnbs_fetch_series", {
        "setId": str(set_id),
        "metricIds": [str(metric_id)],
        "periods": ["2024YY"],
    })
    assert_ok(series)
    sc = assert_structured(series)
    if "series" not in sc:
        raise CaseFail("fetch_series missing 'series'")
    if not deep_has_values(sc.get("series")):
        raise CaseWarn(f"setId={set_id} series empty (NBS value limitation)")
    return f"setId={set_id} metric={metric_id}"


async def wf_node_traversal(ctx: Ctx) -> Optional[str]:
    category = "3"
    parent_id: Optional[str] = None
    for depth in range(4):
        args: dict = {"categories": category}
        if parent_id:
            args["parentId"] = parent_id
        nodes_result = await ctx.call("cnbs_fetch_nodes", args)
        assert_ok(nodes_result)
        nodes = dig(assert_structured(nodes_result), "results", 0, "data")
        if not isinstance(nodes, list) or not nodes:
            raise CaseSkip(f"no nodes at depth {depth}")
        leaf = next((n for n in nodes if n.get("isLeaf")), None)
        if leaf:
            set_id = leaf.get("_id")
            metrics = await ctx.call("cnbs_fetch_metrics", {"setIds": str(set_id)})
            assert_ok(metrics)
            assert_union_shape(assert_structured(metrics))
            return f"leaf={set_id} at depth {depth}"
        parent_id = nodes[0].get("_id")
        if not parent_id:
            raise CaseSkip("branch node missing _id; cannot descend")
    raise CaseSkip("no leaf node found within 4 levels")


async def wf_batch_series(ctx: Ctx) -> Optional[str]:
    search = await ctx.call("cnbs_search", {"keyword": "GDP", "pageSize": 5})
    assert_ok(search)
    data = dig(assert_structured(search), "results", "data")
    if not isinstance(data, list) or not data:
        raise CaseSkip("cnbs_search returned no rows; cannot build batch query")
    first = data[0]
    set_id = first.get("cid")
    metric_id = first.get("indic_id")
    if not set_id or not metric_id:
        raise CaseSkip("search row missing cid/indic_id")
    batch = await ctx.call("cnbs_batch_series", {
        "queries": [{
            "setId": str(set_id),
            "metricIds": [str(metric_id)],
            "periods": ["2024YY"],
        }],
    })
    assert_ok(batch)
    sc = assert_structured(batch)
    results = sc.get("results")
    if not isinstance(results, list) or sc.get("count") != len(results):
        raise CaseFail("batch_series result shape invalid")
    if not results:
        raise CaseFail("batch_series returned no result entries")
    return f"{len(results)} batch result(s)"


# ─── case registry ──────────────────────────────────────────────────────────
def build_cases() -> list[Case]:
    cases: list[Case] = [
        # CNBS core (live NBS API)
        tool_case("cnbs_search", ["cnbs"], "cnbs_search",
                  {"keyword": "GDP", "pageSize": 10}, v_cnbs_search),
        tool_case("cnbs_batch_search", ["cnbs"], "cnbs_batch_search",
                  {"keywords": ["GDP", "CPI", "人口"], "pageSize": 3}, v_union),
        tool_case("cnbs_economic_snapshot", ["cnbs"], "cnbs_economic_snapshot",
                  {}, v_snapshot),
        tool_case("cnbs_quick_query", ["cnbs"], "cnbs_quick_query",
                  {"keyword": "居民消费价格指数"}, v_quick_query),
        tool_case("cnbs_fetch_nodes", ["cnbs"], "cnbs_fetch_nodes",
                  {"categories": ["1", "3"]}, v_union),
        tool_case("cnbs_compare_region", ["cnbs"], "cnbs_compare",
                  {"keyword": "GDP", "regions": ["北京", "上海"], "compareType": "region"},
                  v_compare),
        tool_case("cnbs_compare_time", ["cnbs"], "cnbs_compare",
                  {"keyword": "GDP", "compareType": "time", "years": ["2022", "2023", "2024"]},
                  v_compare),
        tool_case("cnbs_fetch_end_nodes", ["cnbs", "slow"], "cnbs_fetch_end_nodes",
                  {"category": "3"}, v_has_data),

        # CNBS aux passthrough (live)
        tool_case("cnbs_fetch_data_from_source_cnbs", ["cnbs"], "cnbs_fetch_data_from_source",
                  {"source": "cnbs", "params": {"keyword": "GDP"}}, v_wrapped_result),
        tool_case("cnbs_fetch_data_from_source_intl", ["global"], "cnbs_fetch_data_from_source",
                  {"source": "international",
                   "params": {"source": "world_bank", "indicator": "GDP", "country": "CHN"}},
                  v_wrapped_result),
        tool_case("cnbs_search_in_source_census", ["census"], "cnbs_search_in_source",
                  {"source": "census", "keyword": "人口"}, v_wrapped_result),
        tool_case("cnbs_get_source_categories_intl", ["global"], "cnbs_get_source_categories",
                  {"source": "international"}, v_categories),

        # World Bank
        tool_case("ext_world_bank", ["world_bank"], "ext_world_bank",
                  {"indicator": "GDP_GROWTH", "countries": ["CHN", "USA"],
                   "startYear": 2018, "endYear": 2023}, v_has_data),
        tool_case("ext_world_bank_multi", ["world_bank"], "ext_world_bank_multi",
                  {"indicators": ["GDP_GROWTH", "CPI"], "countries": ["CHN", "USA"],
                   "startYear": 2018}, v_has_data),

        # IMF
        tool_case("ext_imf_single", ["imf"], "ext_imf",
                  {"indicators": "GDP_GROWTH", "countries": ["CHN", "USA"],
                   "periods": ["2021", "2022", "2023"]}, v_union),
        tool_case("ext_imf_multi", ["imf"], "ext_imf",
                  {"indicators": ["GDP_GROWTH", "CPI_INFLATION"], "countries": ["CHN"]}, v_union),
        tool_case("ext_imf_all_indicators", ["imf"], "ext_imf_all_indicators",
                  {}, v_has_data),

        # OECD
        tool_case("ext_oecd", ["oecd"], "ext_oecd",
                  {"dataset": "QNA_GDP", "lastNObservations": 4}, v_has_data),

        # BIS
        tool_case("ext_bis_single", ["bis"], "ext_bis",
                  {"dataset": "EER", "countries": "CN", "lastNObservations": 6}, v_union),
        tool_case("ext_bis_multi", ["bis"], "ext_bis",
                  {"dataset": "EER", "countries": ["CN", "US"], "lastNObservations": 6}, v_union),

        # Census / Department
        tool_case("ext_cn_census", ["census"], "ext_cn_census",
                  {"type": "population", "pageSize": 10}, v_has_data),
        tool_case("ext_cn_department", ["department"], "ext_cn_department",
                  {"department": "finance", "pageSize": 10}, v_has_data),

        # Cross-source
        tool_case("ext_global_compare", ["global"], "ext_global_compare",
                  {"wbIndicator": "GDP_GROWTH", "imfIndicator": "GDP_GROWTH",
                   "countries": ["CHN", "USA"], "startYear": 2018}, v_global_compare),

        # Chained workflows
        Case("workflow_discovery_to_series", ("cnbs", "workflow"), wf_discovery_to_series),
        Case("workflow_node_traversal", ("cnbs", "workflow"), wf_node_traversal),
        Case("workflow_batch_series", ("cnbs", "workflow"), wf_batch_series),
    ]
    return cases


# ─── selection + runner ──────────────────────────────────────────────────────
@dataclass
class CaseResult:
    name: str
    tags: tuple[str, ...]
    status: str  # PASS | WARN | SKIP | FAIL
    duration_ms: int
    message: str = ""


def split_csv(value: Optional[str]) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def select_cases(cases: list[Case], only: list[str], tags: list[str]) -> list[Case]:
    selected = []
    for case in cases:
        if only and not any(o.lower() in case.name.lower() for o in only):
            continue
        if tags and not (set(tags) & set(case.tags)):
            continue
        selected.append(case)
    return selected


def is_explicitly_selected(case: Case, only: list[str], tags: list[str]) -> bool:
    if only and any(o.lower() in case.name.lower() for o in only):
        return True
    if tags and (set(tags) & set(case.tags)):
        return True
    return False


async def run_case(ctx: Ctx, case: Case, timeout: float, attempts: int) -> CaseResult:
    start = time.monotonic()
    last: tuple[str, str] = ("FAIL", "not run")
    for attempt in range(1, attempts + 1):
        try:
            note = await asyncio.wait_for(case.run(ctx), timeout)
            last = ("PASS", note or "")
            break
        except CaseSkip as exc:
            last = ("SKIP", str(exc))
            break
        except CaseWarn as exc:
            last = ("WARN", str(exc))
            break
        except CaseFail as exc:
            last = ("FAIL", str(exc))
        except asyncio.TimeoutError:
            last = ("FAIL", f"timeout after {timeout:g}s")
        except Exception as exc:  # noqa: BLE001 - surface any runtime error as failure
            last = ("FAIL", format_exception(exc).splitlines()[-1])
        if attempt < attempts and last[0] == "FAIL":
            await asyncio.sleep(0.5 * attempt)
        else:
            break
    duration_ms = int((time.monotonic() - start) * 1000)
    return CaseResult(case.name, case.tags, last[0], duration_ms, last[1])


# ─── CLI ──────────────────────────────────────────────────────────────────────
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Live integration test suite for a local cnbs-mcp-server (Streamable HTTP).")
    parser.add_argument("--url", default="http://127.0.0.1:12345/mcp", help="MCP HTTP endpoint URL.")
    parser.add_argument("--token", help="Bearer token if the server was started with auth enabled.")
    parser.add_argument("--tool", help="Ad-hoc: call a single tool then exit (bypasses the suite).")
    parser.add_argument("--arguments", default="{}", help="Ad-hoc tool arguments as a JSON object.")
    parser.add_argument("--list-only", action="store_true", help="Only initialize and list tools.")
    parser.add_argument("--list-cases", action="store_true", help="List registered cases and exit (no server).")
    parser.add_argument("--only", help="Comma-separated substrings; run only matching case names.")
    parser.add_argument("--tag", help="Comma-separated tags to filter cases (e.g. world_bank,imf).")
    parser.add_argument("--fail-fast", action="store_true", help="Stop at the first FAIL.")
    parser.add_argument("--attempts", "--retries", dest="attempts", type=int, default=2,
                        help="Total attempts per case (retry on FAIL). Default 2.")
    parser.add_argument("--timeout", type=float, default=30.0, help="Per-case timeout in seconds.")
    parser.add_argument("--json", dest="json_path", help="Write a JSON report to this path.")
    return parser.parse_args()


STATUS_ORDER = ["PASS", "WARN", "SKIP", "FAIL"]


def print_case_line(index: int, total: int, result: CaseResult) -> None:
    detail = f" - {result.message}" if result.message else ""
    print(f"[{index:>2}/{total}] {result.status:<4} {result.name} ({result.duration_ms} ms){detail}")


async def run_suite(session: ClientSession, cases: list[Case], args: argparse.Namespace,
                    only: list[str], tags: list[str]) -> int:
    ctx = Ctx(session)
    total = len(cases)
    results: list[CaseResult] = []
    print(f"\nRunning {total} case(s)...\n")
    for index, case in enumerate(cases, start=1):
        if "slow" in case.tags and not is_explicitly_selected(case, only, tags):
            result = CaseResult(case.name, case.tags, "SKIP",
                                0, "slow case; select with --tag slow or --only")
        else:
            result = await run_case(ctx, case, args.timeout, max(1, args.attempts))
        results.append(result)
        print_case_line(index, total, result)
        if args.fail_fast and result.status == "FAIL":
            print("\n--fail-fast: stopping after first failure.")
            break

    counts = {status: sum(1 for r in results if r.status == status) for status in STATUS_ORDER}
    print("\n" + "=" * 60)
    print("Summary: " + "  ".join(f"{status}={counts[status]}" for status in STATUS_ORDER)
          + f"  (of {total})")
    failed = [r for r in results if r.status == "FAIL"]
    if failed:
        print("\nFailed cases:")
        for r in failed:
            print(f"  - {r.name}: {r.message}")

    if args.json_path:
        report = {
            "url": args.url,
            "total": total,
            "counts": counts,
            "cases": [
                {"name": r.name, "tags": list(r.tags), "status": r.status,
                 "duration_ms": r.duration_ms, "message": r.message}
                for r in results
            ],
        }
        with open(args.json_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
        print(f"\nJSON report written to {args.json_path}")

    return 1 if failed else 0


async def run(args: argparse.Namespace) -> int:
    all_cases = build_cases()
    only = split_csv(args.only)
    tags = split_csv(args.tag)
    selected = select_cases(all_cases, only, tags)

    if args.list_cases:
        print(f"Registered cases ({len(all_cases)} total, {len(selected)} selected):")
        for case in all_cases:
            marker = "*" if case in selected else " "
            print(f" {marker} {case.name}  [{', '.join(case.tags)}]")
        return 0

    if not selected and not args.tool and not args.list_only:
        print("No cases matched the given --only/--tag filters.", file=sys.stderr)
        return 1

    headers = {"Authorization": f"Bearer {args.token}"} if args.token else None
    import httpx
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    async with httpx.AsyncClient(headers=headers, trust_env=False) as http_client:
        async with streamable_http_client(args.url, http_client=http_client) as (read_stream, write_stream, _):
            async with ClientSession(read_stream, write_stream) as session:
                init_result = await session.initialize()
                tools_result = await session.list_tools()
                server_info = (get_field(init_result, "serverInfo")
                               or get_field(init_result, "server_info") or init_result)

                print("Connected:")
                print(json.dumps(to_jsonable(server_info), ensure_ascii=False, indent=2))
                print(f"\nTools: {len(tools_result.tools)}")
                for tool in tools_result.tools[:40]:
                    print(f"- {tool.name}: {tool.description or ''}"[:120])

                if args.list_only:
                    return 0

                if args.tool:
                    tool_arguments = json.loads(args.arguments)
                    if not isinstance(tool_arguments, dict):
                        raise ValueError("--arguments must be a JSON object")
                    print(f"\nCalling tool: {args.tool}")
                    result = await session.call_tool(args.tool, tool_arguments)
                    print(json.dumps(to_jsonable(result), ensure_ascii=False, indent=2))
                    return 0

                return await run_suite(session, selected, args, only, tags)


def main() -> int:
    args = parse_args()
    try:
        return asyncio.run(run(args))
    except BaseException as exc:
        print("ERROR:", file=sys.stderr)
        print(format_exception(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
