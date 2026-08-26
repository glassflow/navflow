---
description: Waive a disputed finding from the last failed Codex review so it stops blocking the commit.
argument-hint: "[n|all]"
allowed-tools: [Bash]
---

The user invoked /tares:challenger-waive with: $ARGUMENTS

Run, from the repository root:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/challenger.py" waive $ARGUMENTS
```

Show the user its output verbatim. If it lists the blocking findings and asks which one, ask the user and run it again with the number. Do not edit the waiver file yourself and do not re-run the review.
