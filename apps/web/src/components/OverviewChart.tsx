import { useEffect, useRef } from "react";
import { init, use, type EChartsCoreOption } from "echarts/core";
import { BarChart, PieChart } from "echarts/charts";
import {
  GraphicComponent,
  GridComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { GraphStats } from "../../../../packages/shared/src/index";
use([
  BarChart,
  PieChart,
  GraphicComponent,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
]);
export default function OverviewChart({
  stats,
  kind,
}: {
  stats: GraphStats;
  kind: "layers" | "communities";
}) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const chart = init(element.current, null, { renderer: "canvas" });
    const tooltip = {
      backgroundColor: "#172433",
      borderColor: "#314153",
      textStyle: { color: "#e7eef7", fontSize: 11 },
    };
    const option: EChartsCoreOption =
      kind === "layers"
        ? {
            tooltip: { ...tooltip, trigger: "axis" },
            grid: { left: 28, right: 10, top: 14, bottom: 30 },
            xAxis: {
              type: "category",
              data: stats.layers.map((layer) =>
                layer.depth === 0 ? "起点" : `${layer.depth} 度`,
              ),
              axisLine: { lineStyle: { color: "#293444" } },
              axisTick: { show: false },
              axisLabel: { color: "#8594a7", fontSize: 10 },
            },
            yAxis: {
              type: "value",
              minInterval: 1,
              splitLine: { lineStyle: { color: "#202b39", type: "dashed" } },
              axisLabel: { color: "#617185", fontSize: 9 },
            },
            series: [
              {
                type: "bar",
                data: stats.layers.map((layer) => layer.count),
                barMaxWidth: 28,
                itemStyle: { color: "#65d5bf", borderRadius: [4, 4, 0, 0] },
              },
            ],
          }
        : {
            tooltip: {
              ...tooltip,
              trigger: "item",
              formatter: "{b}: {c} 个节点 ({d}%)",
            },
            color: [
              "#65d5bf",
              "#899ef0",
              "#edbc77",
              "#bd91da",
              "#72b8d2",
              "#b8d78b",
            ],
            series: [
              {
                type: "pie",
                radius: ["49%", "75%"],
                center: ["50%", "50%"],
                label: { show: false },
                itemStyle: {
                  borderColor: "#111a26",
                  borderWidth: 3,
                  borderRadius: 3,
                },
                data: stats.communities.map((community) => ({
                  name: `社群 ${community.id + 1}`,
                  value: community.size,
                })),
              },
            ],
            graphic: [
              {
                type: "text",
                left: "center",
                top: "39%",
                style: {
                  text: String(stats.communities.length),
                  fill: "#e6eef8",
                  font: "600 25px sans-serif",
                  textAlign: "center",
                },
              },
              {
                type: "text",
                left: "center",
                top: "62%",
                style: {
                  text: "个社群",
                  fill: "#7d8c9f",
                  font: "10px sans-serif",
                  textAlign: "center",
                },
              },
            ],
          };
    chart.setOption(option);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [stats, kind]);
  return (
    <div
      ref={element}
      className="overview-chart"
      role="img"
      aria-label={
        kind === "layers"
          ? `层级分布：${stats.layers.map((layer) => `${layer.depth} 度 ${layer.count} 人`).join("，")}`
          : `${stats.communities.length} 个已采集网络社群`
      }
    />
  );
}
