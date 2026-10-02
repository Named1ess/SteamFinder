import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./ui";

/** Keep a visited panel mounted, including its ongoing jobs and selected player. */
export function DeferredPanel({ id, title, description, children }: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [activated, setActivated] = useState(() => window.location.hash === `#${id}`);
  useEffect(() => {
    if (activated) return;
    const activateHash = () => {
      if (window.location.hash === `#${id}`) setActivated(true);
    };
    window.addEventListener("hashchange", activateHash);
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setActivated(true);
    }, { rootMargin: "180px 0px" });
    if (container.current) observer.observe(container.current);
    return () => { observer.disconnect(); window.removeEventListener("hashchange", activateHash); };
  }, [activated, id]);
  const placeholder = (
    <section id={id} className="deferred-panel" aria-label={title}>
      <div><h2>{title}</h2><p>{description}</p></div>
      <Button variant="secondary" onClick={() => setActivated(true)}>
        {activated ? "正在读取…" : `查看${title}`}
      </Button>
    </section>
  );
  return <div ref={container}>{activated ? <Suspense fallback={placeholder}>{children}</Suspense> : placeholder}</div>;
}
