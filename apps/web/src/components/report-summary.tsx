"use client";

/**
 * Renders a triage report markdown as a readable summary.
 * Extracts key sections and renders them without needing a full markdown library.
 */
export function ReportSummary({ markdown }: { markdown: string }) {
  // If the content looks like raw JSON (OpenCode format), it wasn't parsed properly
  const isRawJson =
    markdown.trim().startsWith("{") || markdown.trim().startsWith("[");

  if (isRawJson) {
    return (
      <div className="text-sm text-[var(--ink-muted)]">
        <p>
          Report data received but could not be parsed into a readable format.
        </p>
        <p className="mt-1 text-xs">
          Expand &ldquo;Full report&rdquo; below to see raw output.
        </p>
      </div>
    );
  }

  // Extract first meaningful paragraph as summary (skip headings, blank lines)
  const lines = markdown.split("\n");
  const sections: Array<{ heading: string; content: string[] }> = [];
  let currentSection: { heading: string; content: string[] } = {
    heading: "",
    content: [],
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      if (currentSection.heading || currentSection.content.length > 0) {
        sections.push(currentSection);
      }
      currentSection = { heading: headingMatch[1], content: [] };
    } else if (line.trim()) {
      currentSection.content.push(line);
    }
  }
  if (currentSection.heading || currentSection.content.length > 0) {
    sections.push(currentSection);
  }

  // Show first 3 sections max as summary
  const summaryParts = sections.slice(0, 3);

  if (summaryParts.length === 0) {
    // Fallback: show first 300 chars
    const cleaned = markdown.replace(/\s+/g, " ").trim();
    return (
      <p className="text-sm text-[var(--ink)]">
        {cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {summaryParts.map((section, idx) => (
        <div key={idx}>
          {section.heading && (
            <h4 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--ink-muted)] mb-1">
              {section.heading}
            </h4>
          )}
          {section.content.map((line, lineIdx) => {
            // Render bullet points
            const bulletMatch = line.match(/^[-*]\s+(.+)/);
            if (bulletMatch) {
              return (
                <p
                  key={lineIdx}
                  className="text-sm text-[var(--ink)] pl-3 before:content-['•'] before:mr-2 before:text-[var(--ink-muted)]"
                >
                  {bulletMatch[1]}
                </p>
              );
            }
            // Render code blocks inline
            const parts = line.split(/(`[^`]+`)/g);
            return (
              <p key={lineIdx} className="text-sm text-[var(--ink)]">
                {parts.map((part, partIdx) =>
                  part.startsWith("`") && part.endsWith("`") ? (
                    <code
                      key={partIdx}
                      className="rounded bg-[var(--surface)] px-1 py-0.5 text-xs font-mono text-[var(--ink)]"
                    >
                      {part.slice(1, -1)}
                    </code>
                  ) : (
                    <span key={partIdx}>{part}</span>
                  ),
                )}
              </p>
            );
          })}
        </div>
      ))}
      {sections.length > 3 && (
        <p className="text-xs text-[var(--ink-muted)]">
          + {sections.length - 3} more sections in full report
        </p>
      )}
    </div>
  );
}
