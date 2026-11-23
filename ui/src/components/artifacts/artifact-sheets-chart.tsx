import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cellKey, columnLabel, displaySheetValue, readRange, type SheetChart, type SheetValue } from "./artifact-sheets-model";

const palette = ["var(--primary)", "#0f766e", "#c2410c", "#7e22ce", "#a21caf", "#2563eb", "#b45309", "#be123c"];
const tooltipStyle = {
  background: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: 6,
};

function chartData(chart: SheetChart, get: (address: string) => SheetValue) {
  const range = readRange(chart.range);
  if (!range) return { series: [], data: [] };
  const { start, end } = range;
  const series = Array.from({ length: end.col - start.col }, (_, index) => {
    const col = start.col + index + 1;
    return { key: "series" + index, col, label: displaySheetValue(get(cellKey({ row: start.row, col }))) || columnLabel(col) };
  });
  const data = [];
  for (let row = start.row + 1; row <= end.row; row += 1) {
    const category = displaySheetValue(get(cellKey({ row, col: start.col }))) || String(row);
    const entry: Record<string, string | number | null> = { category };
    let numeric = false;
    for (const item of series) {
      const value = get(cellKey({ row, col: item.col })).value;
      entry[item.key] = typeof value === "number" ? value : null;
      numeric ||= typeof value === "number";
    }
    if (numeric) data.push(entry);
  }
  return { series, data };
}

export function ArtifactSheetChart({ chart, sheetName, getValue }: {
  chart: SheetChart;
  sheetName: string;
  getValue: (sheetName: string, key: string) => SheetValue;
}) {
  const { series, data } = useMemo(() => chartData(chart, (key) => getValue(sheetName, key)), [chart, sheetName, getValue]);
  const pieSeries = series[0];
  const pie = chart.kind === "pie" && pieSeries
    ? data.flatMap((row, index) => {
      const value = row[pieSeries.key];
      return typeof value === "number" && value > 0
        ? [{ category: row.category, value, fill: palette[index % palette.length] }]
        : [];
    })
    : [];
  if (data.length === 0 || (chart.kind === "pie" && pie.length === 0)) {
    return <p className="p-3 text-sm text-muted-foreground">There are no {chart.kind === "pie" ? "positive" : "numeric"} values in {chart.range}.</p>;
  }

  return (
    <figure className="h-48 w-full min-w-0 px-1 text-xs" aria-label={chart.title}>
      <ResponsiveContainer width="100%" height="100%">
        {chart.kind === "pie" ? (
          <PieChart>
            <Pie data={pie} dataKey="value" nameKey="category" innerRadius="48%" outerRadius="84%" isAnimationActive={false} />
            <Tooltip contentStyle={tooltipStyle} />
            <Legend />
          </PieChart>
        ) : chart.kind === "line" ? (
          <LineChart data={data} margin={{ right: 16, left: -6 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="category" stroke="var(--muted-foreground)" />
            <YAxis stroke="var(--muted-foreground)" />
            <Tooltip contentStyle={tooltipStyle} />
            {series.length > 1 && <Legend />}
            {series.map((item, index) => <Line key={item.key} dataKey={item.key} name={item.label}
              stroke={palette[index % palette.length]} strokeWidth={2} dot={data.length < 20} connectNulls={false} isAnimationActive={false} />)}
          </LineChart>
        ) : (
          <BarChart data={data} margin={{ right: 16, left: -6 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="category" stroke="var(--muted-foreground)" />
            <YAxis stroke="var(--muted-foreground)" />
            <Tooltip contentStyle={tooltipStyle} />
            {series.length > 1 && <Legend />}
            {series.map((item, index) => <Bar key={item.key} dataKey={item.key} name={item.label}
              fill={palette[index % palette.length]} radius={[2, 2, 0, 0]} isAnimationActive={false} />)}
          </BarChart>
        )}
      </ResponsiveContainer>
    </figure>
  );
}
