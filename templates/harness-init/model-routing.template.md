# Model Routing

Use this template in each target repository when Claude Code and Codex are both
available.

```yaml
model_routing:
  source_date: "2026-07-02"
  orchestrator:
    terminal: "[ORCH-CLAUDE]"
    engine: "Claude Code"
    preferred_model_class: "most capable available Claude model"
    fallback_model_class: "Sonnet-class Claude model"
    authority: "Task Contract, role routing, question answers, In Review only"
  coder:
    terminal: "[CODER-CLAUDE]"
    engine: "Claude Code"
    preferred_model_class: "Sonnet-class or stronger Claude model"
    fallback_model_class: "fast Claude model for small mechanical edits"
    authority: "implementation inside declared write scope"
  verifier:
    terminal: "[VERIFY-CODEX]"
    engine: "Codex"
    preferred_model_class: "gpt-5.5 or strongest available Codex model"
    fallback_model_class: "gpt-5.4"
    authority: "real command-based PASS or FAIL for loop tasks"
  reviewer:
    terminal: "[REVIEW-CODEX]"
    engine: "Codex"
    preferred_model_class: "gpt-5.5 for high-risk review, gpt-5.4 for normal review"
    fallback_model_class: "fast Codex model for non-authoritative secondary checks"
    authority: "scope, risk, evidence, and non-loop checklist review"
  human:
    owner: "한용"
    authority: "final Done, subjective decisions, irreversible approval"
```

Keep the role boundary even when a different model is selected. A stronger model
does not gain extra authority, and a faster model must not be used as the sole
authority for verifier PASS or high-risk review.

