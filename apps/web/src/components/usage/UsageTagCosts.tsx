import type { UsageTagCost } from "@t3tools/contracts";
import { useState } from "react";
import { formatCount, formatUsd } from "@t3tools/shared/usageFormat";

import { Input } from "../ui/input";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export function UsageTagCosts({ rows }: { readonly rows: readonly UsageTagCost[] }) {
  const [filter, setFilter] = useState("");
  const matching = rows.filter((row) =>
    row.tag.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const peak = matching.reduce((max, row) => Math.max(max, row.costUsd), 0);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="tag-cost-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="tag-cost-heading" className="text-sm font-medium text-foreground">
          Cost by request tag
        </h2>
        <div className="w-60 max-w-full">
          <Input
            aria-label="Filter request tags"
            placeholder="Filter tags, e.g. jira: or project:"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Local main-agent estimates at gateway rates. Tags are saved with each turn. A turn can
        appear under several tags, so rows do not add up to total spend. Unpriced turns are excluded
        from cost.
      </p>
      {matching.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          {filter.trim()
            ? "No matching tags in this period."
            : "No recorded tag costs in this period. Run a tagged LiteLLM turn to start tracking."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Tag</th>
                <th className="px-3 pb-2 font-medium">Provider</th>
                <th className="pb-2 text-right font-medium">Estimate</th>
                <th className="ps-3 pb-2 text-right font-medium">Priced turns</th>
                <th className="ps-3 pb-2 text-right font-medium">Unpriced</th>
              </tr>
            </thead>
            <tbody>
              {matching.slice(0, 100).map((row) => (
                <tr
                  key={JSON.stringify([row.provider, row.tag])}
                  className="border-b border-border/50"
                >
                  <td className="min-w-32 py-3">
                    <span className="break-all font-mono text-xs">{row.tag}</span>
                    <div className="mt-1 h-1 rounded-full bg-muted" aria-hidden>
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${peak === 0 ? 0 : (row.costUsd / peak) * 100}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-3 text-xs text-muted-foreground">
                    {PROVIDER_PRESENTATION[row.provider].label}
                  </td>
                  <td className="text-right tabular-nums">
                    {row.pricedTurns === 0
                      ? "Unpriced"
                      : `${formatUsd(row.costUsd)}${row.unpricedTurns > 0 ? "+" : ""}`}
                  </td>
                  <td className="ps-3 text-right tabular-nums">{formatCount(row.pricedTurns)}</td>
                  <td className="ps-3 text-right tabular-nums text-muted-foreground">
                    {formatCount(row.unpricedTurns)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {matching.length > 100 ? (
            <p className="pt-2 text-xs text-muted-foreground">
              Showing the first 100 rows. Filter tags to narrow the list.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
