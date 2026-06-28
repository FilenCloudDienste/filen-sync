import pathModule from "path"
import { renderReport } from "./harness/measure"

/**
 * Standalone report renderer: reads the JSONL the bench run appended and writes a grouped markdown
 * table. Decoupled from the vitest lifecycle (vitest workers don't reliably fire exit hooks).
 *
 *   tsx tests/bench/render.ts [label] [inJsonl] [outMd]
 */
const label = process.argv[2] ?? process.env["BENCH_LABEL"] ?? "run"
const inJsonl = process.argv[3] ?? process.env["BENCH_JSONL"] ?? pathModule.join(process.cwd(), "docs/perf/benchmarks/_results.jsonl")
const outMd = process.argv[4] ?? process.env["BENCH_OUT"] ?? pathModule.join(process.cwd(), `docs/perf/benchmarks/${label}.md`)

renderReport(inJsonl, outMd, label)
