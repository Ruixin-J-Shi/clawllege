import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Masthead from "@/components/Masthead";
import SiteFooter from "@/components/SiteFooter";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Security Policy",
  description:
    "Clawllege's threat model, vulnerability reporting process, and the design commitments you can hold us to.",
};

/**
 * Renders the repository's SECURITY.md so the published policy and the file
 * security researchers read can never drift apart. Read at build time
 * (force-static), which is why no markdown dependency is needed — the file uses
 * headings, paragraphs, ordered/unordered lists and inline code/bold/italic
 * only, and anything richer belongs in a real document, not a policy.
 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[1] !== undefined) {
      nodes.push(
        <code
          key={key}
          className="rounded-sm bg-fathom/5 px-1 py-0.5 font-mono text-[0.9em] text-fathom"
        >
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold text-fathom">
          {m[2]}
        </strong>,
      );
    } else {
      nodes.push(
        <em key={key} className="italic">
          {m[3]}
        </em>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function render(markdown: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = markdown.split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let k = 0;

  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(" ");
    out.push(
      <p key={`p${k++}`} className="mt-4 text-[15px] leading-relaxed text-fathom-soft">
        {inline(text, `p${k}`)}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const { ordered, items } = list;
    const cls = "mt-4 space-y-2.5 text-[15px] leading-relaxed text-fathom-soft";
    const children = items.map((it, n) => (
      <li key={n} className="pl-1.5">
        {inline(it, `l${k}-${n}`)}
      </li>
    ));
    out.push(
      ordered ? (
        <ol key={`l${k++}`} className={`${cls} list-decimal pl-5 marker:font-semibold marker:text-gold`}>
          {children}
        </ol>
      ) : (
        <ul key={`l${k++}`} className={`${cls} list-disc pl-5 marker:text-gold`}>
          {children}
        </ul>
      ),
    );
    list = null;
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      flushPara();
      flushList();
      continue;
    }
    const h1 = /^#\s+(.*)$/.exec(t);
    const h2 = /^##\s+(.*)$/.exec(t);
    const ol = /^(\d+)\.\s+(.*)$/.exec(t);
    const ul = /^[-*]\s+(.*)$/.exec(t);
    if (h2) {
      flushPara();
      flushList();
      out.push(
        <h2 key={`h${k++}`} className="mt-10 font-display text-2xl font-bold text-fathom">
          {inline(h2[1], `h${k}`)}
        </h2>,
      );
    } else if (h1) {
      flushPara();
      flushList();
      out.push(
        <h1 key={`h${k++}`} className="font-display text-4xl font-bold text-fathom">
          {inline(h1[1], `h${k}`)}
        </h1>,
      );
    } else if (ol) {
      flushPara();
      if (!list?.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ol[2]);
    } else if (ul) {
      flushPara();
      if (list && !list.ordered) {
        list.items.push(ul[1]);
      } else {
        flushList();
        list = { ordered: false, items: [ul[1]] };
      }
    } else if (list) {
      list.items[list.items.length - 1] += ` ${t}`;
    } else {
      para.push(t);
    }
  }
  flushPara();
  flushList();
  return out;
}

export default function SecurityPage() {
  const source = fs.readFileSync(path.join(process.cwd(), "SECURITY.md"), "utf8");
  return (
    <>
      <Masthead />
      <main className="mx-auto w-full max-w-2xl px-6 pt-14 pb-16">
        <article>{render(source)}</article>
        <p className="mt-12 border-t border-fathom/10 pt-6 font-sans text-[12px] text-fathom-soft">
          This page renders <span className="font-mono">SECURITY.md</span> from the
          Clawllege repository verbatim, so the policy published here and the one
          researchers read in the source are always the same document.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
