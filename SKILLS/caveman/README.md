# caveman

Talk like smart caveman. Same brain, fewer tokens.

## What it does

Compress model responses to caveman-style prose by dropping articles, filler,
pleasantries, and hedging. Instruction preserves technical detail, code blocks,
error strings, and symbols. Result depends on model and workload; no aggregate
reduction or quality-equivalence claim is published, and mode persists until
changed or stopped.


## Example output

Question: "Why does my React component re-render?"

Normal prose:
> Your component re-renders because you create a new object reference each render. Wrapping it in `useMemo` will fix the issue.

Caveman (full):
> New object ref each render. Inline object prop = new ref = re-render. Wrap in `useMemo`.

Caveman (ultra):
> Inline obj prop → new ref → re-render. `useMemo`.

