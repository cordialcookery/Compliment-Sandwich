import type { PropsWithChildren, ReactNode } from "react";
import clsx from "clsx";

type RetroWindowProps = PropsWithChildren<{
  title: string;
  className?: string;
  toolbar?: ReactNode;
}>;

export function RetroWindow({ title, className, toolbar, children }: RetroWindowProps) {
  return (
    <section className={clsx("retro-window", className)}>
      <div className="retro-title-bar">
        <span>{title}</span>
        <div className="retro-title-buttons" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
      {toolbar ? <div className="retro-toolbar">{toolbar}</div> : null}
      <div className="retro-window-body">{children}</div>
    </section>
  );
}
