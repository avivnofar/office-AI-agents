# Guide Topics — Fallback List

Consulted by `workers/guide-engine.js`'s `selectGuideTopic()` when today's
capability gaps (`reports` rows, `type='gap_hebrew'`) don't yield an eligible
topic. Stale-by-design — the owner has said plainly he will rarely update
this — so `selectGuideTopic()` is built to tolerate that: topics are skipped
automatically once a guide for them is `approved` or already in progress
(checked in D1's `guide_pipeline` table first, not by editing this file).

Format: one topic per line under its domain heading —

```
- `slug` — Title — one-line description
```

Domains here match `guides/<domain>/` exactly (`networking`, `firewall`,
`windows`, `ai`, `linux`, `cloud`, `cybersecurity`). Topics are picked in
file order within each domain, domains in the order listed below (HIGH
priority first, per CLAUDE.md's "Domain priorities").

**Windows is seeded here deliberately dense** — Notebook-X and data-center's
own question pool don't cover Windows at all today, so Windows guides will
only ever come from this list, never from a capability gap.

## windows

- `windows-cmd-network-troubleshooting` — Diagnosing network issues from the Windows command line — ipconfig, ping, tracert, netstat, and nslookup in a practical troubleshooting sequence.
- `windows-event-viewer-basics` — Reading Windows Event Viewer for IT support — the logs that matter, the noise to ignore, and how to correlate an event ID to a real cause.
- `windows-service-troubleshooting` — Diagnosing a Windows service that fails to start — sc query, services.msc, dependency chains, and the event log entries to check first.
- `windows-group-policy-basics` — Group Policy fundamentals for IT support — gpupdate, gpresult, and troubleshooting a policy that isn't applying to a specific machine or user.
- `windows-disk-and-storage-cmd` — Diagnosing disk and storage issues from the command line — chkdsk, diskpart, and Storage Sense, with when each is the right tool.
- `windows-user-profile-troubleshooting` — Diagnosing a corrupted or slow-loading Windows user profile — the standard repair sequence before resorting to a profile rebuild.
- `windows-task-scheduler-troubleshooting` — Diagnosing a scheduled task that silently fails — the History tab, exit codes, and the run-as-account permission issues that most often cause this.

## networking

- `networking-dns-inconsistent-resolution` — Tracing why an internal hostname resolves inconsistently across clients on the same subnet — the step-by-step resolution-path check.
- `networking-vlan-trunking-misconfig` — VLAN trunking in practical terms, and the most common misconfiguration that breaks it between two switches.
- `networking-site-to-site-vpn-flapping` — Diagnosing a site-to-site VPN tunnel that renegotiates and drops every few hours — the systematic sequence for isolating the cause.
- `networking-ipsec-vs-wireguard` — Practical tradeoffs between IPsec and WireGuard for a new site-to-site link between two small offices.

## firewall

- `firewall-rule-base-audit` — Auditing a firewall rule base for shadowed or redundant rules — a systematic method for a rule base that grew organically over years, with a Check Point emphasis.
- `firewall-nat-troubleshooting` — Diagnosing NAT-related connectivity failures on a Check Point-style firewall — the ordering between NAT and rule-base evaluation, and where translations silently break.
- `firewall-change-not-taking-effect` — Diagnosing why a firewall rule change doesn't take effect — ordering, policy install/caching, and connection-table persistence.
- `firewall-logging-and-alerting-basics` — Setting up minimal, high-value firewall logging and alerting for a small network without drowning in noise.

## ai

- `ai-token-cost-budgeting` — Setting a sane token/cost budget for an agentic AI workflow before it runs unattended in production.
- `ai-rag-vs-fine-tuning` — The practical (not theoretical) difference between retrieval-augmented generation and fine-tuning, and when each actually wins.
- `ai-prompt-injection-internal-tools` — When prompt-injection risk genuinely matters for an internal LLM-backed tool, and what mitigations are proportionate.

## linux

- `linux-runaway-process-recovery` — Recovering from a runaway process consuming all CPU cores — identifying it, deciding if it's safe to kill, and remediating the cause.
- `linux-log-rotation-setup` — Setting up correct log rotation and capping for a service log that grew without bound and filled a disk.
- `linux-bash-lock-file-pattern` — A bash pattern for safely handling a stale lock file left behind by a killed mid-job process, so a nightly job stops failing on restart.

## cloud

- `cloud-cicd-least-privilege-iam` — Designing a least-privilege IAM role for a CI/CD pipeline that deploys to production — what it should explicitly NOT be able to do.
- `cloud-k8s-crashloopbackoff` — A systematic diagnostic sequence for a Kubernetes pod stuck in CrashLoopBackOff after a routine image update.
- `cloud-minimal-observability-setup` — The minimal useful set of monitors and alerts to stand up first for a small production service with no existing observability.

## cybersecurity

- `cybersecurity-ssh-hardening-checklist` — The minimal, high-value SSH hardening checklist for a Linux host that must remain internet-facing.
- `cybersecurity-phishing-first-hour` — The correct first-hour response sequence when several users report a phishing email from the same sender domain.
- `cybersecurity-vuln-disclosure-process` — The practical steps an internal team should follow when a vulnerability is found in a production system, from discovery to fix.
