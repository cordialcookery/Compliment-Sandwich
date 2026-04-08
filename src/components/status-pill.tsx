import clsx from "clsx";

type StatusPillProps = {
  tone?: "success" | "warning" | "danger" | "neutral";
  children: string;
};

export function StatusPill({ tone = "neutral", children }: StatusPillProps) {
  return <span className={clsx("status-pill", `status-pill--${tone}`)}>{children}</span>;
}
