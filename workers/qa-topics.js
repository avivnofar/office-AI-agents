/**
 * Data Center — AI Agent Simulation — Q&A topic pool.
 *
 * Replaces the retired Netvill/1COM-client CRM case pool (workers/case-generator.js,
 * deleted this session). Every entry here is a REAL QUESTION an agent asks one of
 * the two production AI systems this office exists to stress-test, not a simulated
 * support ticket for a fictional client:
 *
 *   - project: 'data-center' -> asked to Claude via data-center-api's /api/chat
 *     (agent-base.js askAssignedProject() -> askDataCenter()).
 *   - project: 'notebook-x'  -> asked to Gemini via a specific Notebook-X knowledge
 *     notebook (kbSlug) (askNotebookX()). Because this targets ONE named notebook
 *     directly, a null/empty answer is itself a signal worth evaluating (the
 *     notebook doesn't cover this), not just a low-quality-text signal.
 *
 * Weighting (per owner instruction): CORE topics (cloud, AI, networking protocols,
 * Linux/Windows, firewalls) are weighted highest — they're both the owner's stated
 * priority and, for the notebook-x-targeted core entries, the ones most likely to
 * surface a genuine skeleton-notebook gap (kb-cybersecurity/kb-firewall/kb-networking/
 * kb-vpn are dataQuality:'skeleton' as of 2026-07-09 per config/notebook-x-progress.json
 * — asking them real questions is exactly how a skeleton gets caught, not a bug in
 * the weighting). VoIP/PBX topics (kb-voip-sip, kb-mirtapbx, kb-1com) stay in the pool
 * per "no deletions" but at lower weight — they're real, useful coverage, just not the
 * owner's stated priority.
 *
 * kb-bash is intentionally not queried as a separate notebook from kb-linux — same
 * seeded content, same convention already established in config/ai-tools.json's
 * notebook_x.scope_this_integration note. Linux/bash questions route to kb-linux.
 */

/** CORE (weight 3): general IT/cybersecurity questions asked directly to Claude
 * (data-center's AI Search). No client/ticket framing — a real technical question. */
const DATA_CENTER_CORE = [
  { title: 'Diagnosing a service that fails to bind to its configured port', platform: 'linux', category: 'network', difficulty: 'beginner', description: 'A newly deployed service refuses to start, logging "address already in use". How do you identify the conflicting process and resolve it safely?' },
  { title: 'Freeing disk space after an application crash', platform: 'linux', category: 'disk', difficulty: 'intermediate', description: 'An application crashes on write with "No space left on device". What is the safe process for finding and freeing the space actually consuming it?' },
  { title: 'Investigating "Permission denied" on a shared directory', platform: 'linux', category: 'permission', difficulty: 'beginner', description: 'A user in the correct group still cannot write to a shared project directory. What ownership, group, and ACL checks explain this?' },
  { title: 'A critical service fails to start after a package upgrade', platform: 'linux', category: 'system', difficulty: 'intermediate', description: 'What is the right sequence of checks (unit status, logs, config compatibility) after a routine package upgrade breaks a service?' },
  { title: 'Diagnosing intermittent packet loss between two sites', platform: 'network', category: 'diagnostic', difficulty: 'advanced', description: 'Users report intermittent slowness reaching a branch office. What is the correct process for tracing the path and isolating where loss is occurring?' },
  { title: 'A new internal service is blocked from one VLAN only', platform: 'network', category: 'firewall', difficulty: 'advanced', description: 'A newly deployed API is reachable from the server VLAN but blocked from the office VLAN. How do you trace the firewall rule chain to find the block?' },
  { title: 'Explaining a suspected routing loop between two sites', platform: 'network', category: 'routing', difficulty: 'advanced', description: 'Two sites occasionally lose all connectivity with a latency spike just before. What is the diagnostic approach for confirming or ruling out a routing loop?' },
  { title: 'Windows host cannot reach an internal file server by hostname', platform: 'windows', category: 'network', difficulty: 'beginner', description: 'A workstation can browse the internet but not reach an internal file server by name. What connectivity and name-resolution checks isolate the cause?' },
  { title: 'A nightly scheduled task shows "Ready" but never runs', platform: 'windows', category: 'system', difficulty: 'intermediate', description: 'A nightly scheduled backup task shows as Ready in Task Scheduler but never produces output. What are the likely causes and how do you confirm which one applies?' },
  { title: 'A user is locked out after failed logins from an unfamiliar device', platform: 'windows', category: 'user', difficulty: 'beginner', description: 'What is the safe investigation-and-unlock process for a domain account locked out after multiple failed logins from a device the user does not recognize?' },
  { title: 'Choosing between VM, container, and serverless for a stateless API', platform: 'cloud', category: 'architecture', difficulty: 'intermediate', description: 'For a small, bursty, stateless HTTP API, what tradeoffs should drive the choice between a VM, a container platform, and a serverless function?' },
  { title: 'Designing least-privilege IAM for a CI/CD deploy pipeline', platform: 'cloud', category: 'iam', difficulty: 'advanced', description: 'What does a least-privilege IAM role look like for a CI/CD pipeline that needs to deploy to production — what should it explicitly NOT be able to do?' },
  { title: 'Diagnosing a Kubernetes pod stuck in CrashLoopBackOff', platform: 'cloud', category: 'containers', difficulty: 'advanced', description: 'A pod is stuck in CrashLoopBackOff after a routine image update. What is the systematic diagnostic sequence (events, logs, resource limits, probes)?' },
  { title: 'When prompt-injection risk actually matters for an internal tool', platform: 'ai', category: 'security', difficulty: 'advanced', description: 'For an internal LLM-backed tool that only reads company docs, when does prompt-injection risk genuinely apply, and what mitigations are proportionate?' },
  { title: 'Explaining the practical difference between RAG and fine-tuning', platform: 'ai', category: 'architecture', difficulty: 'intermediate', description: 'For a team choosing how to ground an LLM in internal knowledge, what is the practical (not theoretical) difference between retrieval-augmented generation and fine-tuning, and when does each actually win?' },
  { title: 'Setting a sane token/cost budget for an agentic workflow', platform: 'ai', category: 'operations', difficulty: 'intermediate', description: 'What is a reasonable way to estimate and cap token spend for a multi-step agentic workflow before it runs unattended in production?' },
  { title: 'Writing a firewall rule set for a new internal HTTPS service', platform: 'firewall', category: 'rules', difficulty: 'intermediate', description: 'What is the minimal, correct firewall rule set to expose a new internal HTTPS service to one specific VLAN and nothing else?' },
  { title: 'Auditing a firewall rule base for shadowed/redundant rules', platform: 'firewall', category: 'audit', difficulty: 'advanced', description: 'What is a systematic method for finding shadowed or redundant rules in a firewall rule base that has grown organically over years?' },
  { title: 'Explaining BGP route flapping and how to dampen it', platform: 'networking', category: 'protocols', difficulty: 'advanced', description: 'What causes BGP route flapping between two autonomous systems, and what are the tradeoffs of route dampening as a fix?' },
  { title: 'DNS resolves inconsistently across clients on the same subnet', platform: 'networking', category: 'dns', difficulty: 'intermediate', description: 'Some clients resolve an internal hostname correctly while others get NXDOMAIN, on the same subnet. What is the resolution-path tracing process?' },
];

/** CORE (weight 3): questions asked directly against a specific Notebook-X notebook —
 * mostly the newer skeleton-quality notebooks the owner's core-topic list maps onto. */
const NOTEBOOK_X_CORE = [
  { title: 'Recovering from a runaway process consuming all CPU cores', platform: 'linux', category: 'process', difficulty: 'advanced', description: 'A background job has pegged every CPU core for over an hour. How do you identify it, determine if it is safe to kill, and remediate?', kbSlug: 'kb-linux' },
  { title: 'Rotating and capping an application log that grew without bound', platform: 'linux', category: 'logs', difficulty: 'intermediate', description: 'A service log filled the disk overnight. What is the correct rotation/cap setup to prevent recurrence?', kbSlug: 'kb-linux' },
  { title: 'A new employee account is missing a required group', platform: 'linux', category: 'user', difficulty: 'beginner', description: 'A new hire cannot access a shared resource because their account is missing from the expected group. What is the fix and how do you verify it?', kbSlug: 'kb-linux' },
  { title: 'Writing a bash script that safely handles a failed mid-job lock file', platform: 'linux', category: 'scripting', difficulty: 'intermediate', description: 'A nightly backup job fails with "lock file exists" after a previous run was killed mid-job. What bash pattern prevents this from recurring?', kbSlug: 'kb-linux' },
  { title: 'Deploying a container image via GitHub Actions to a cloud target', platform: 'cloud-devops', category: 'ci-cd', difficulty: 'intermediate', description: 'What does a minimal, correct GitHub Actions workflow look like for building and deploying a container image on every merge to main?', kbSlug: 'kb-cloud-devops' },
  { title: 'Setting up basic monitoring/alerting for a small production service', platform: 'cloud-devops', category: 'monitoring', difficulty: 'intermediate', description: 'For a small production service with no existing observability, what is the minimal useful set of monitors and alerts to stand up first?', kbSlug: 'kb-cloud-devops' },
  { title: 'Managing environment-specific config across dev/staging/prod', platform: 'cloud-devops', category: 'config', difficulty: 'intermediate', description: 'What is a clean pattern for managing environment-specific configuration and secrets across dev, staging, and production without duplicating files?', kbSlug: 'kb-cloud-devops' },
  { title: 'Responding to a suspected phishing campaign', platform: 'cybersecurity', category: 'incident-response', difficulty: 'advanced', description: 'Several users report a phishing email from the same sender domain. What is the correct first-hour response sequence?', kbSlug: 'kb-cybersecurity' },
  { title: 'Explaining the practical steps of a vulnerability disclosure process', platform: 'cybersecurity', category: 'process', difficulty: 'intermediate', description: 'What are the practical steps an internal team should follow when a vulnerability is found in a production system, from discovery to fix?', kbSlug: 'kb-cybersecurity' },
  { title: 'Hardening SSH access on an internet-facing Linux host', platform: 'cybersecurity', category: 'hardening', difficulty: 'intermediate', description: 'What is the minimal, high-value SSH hardening checklist for a Linux host that must remain internet-facing?', kbSlug: 'kb-cybersecurity' },
  { title: 'Writing a firewall rule to expose a new service to one VLAN only', platform: 'firewall', category: 'rules', difficulty: 'intermediate', description: 'What is the minimal correct rule to expose a new internal HTTPS service to exactly one VLAN?', kbSlug: 'kb-firewall' },
  { title: 'Diagnosing why a firewall rule change did not take effect', platform: 'firewall', category: 'troubleshooting', difficulty: 'intermediate', description: 'A firewall rule was changed but traffic still behaves as if the old rule is active. What are the likely causes (ordering, caching, rule hits) and how do you check each?', kbSlug: 'kb-firewall' },
  { title: 'Tracing an internal DNS resolution failure step by step', platform: 'networking', category: 'dns', difficulty: 'intermediate', description: 'What is the step-by-step process for tracing why an internal hostname fails to resolve on some clients but not others?', kbSlug: 'kb-networking' },
  { title: 'Explaining VLAN trunking and a common misconfiguration', platform: 'networking', category: 'vlan', difficulty: 'intermediate', description: 'What is VLAN trunking in practical terms, and what is the most common misconfiguration that breaks it between two switches?', kbSlug: 'kb-networking' },
  { title: 'Diagnosing a site-to-site VPN tunnel that drops every few hours', platform: 'vpn', category: 'troubleshooting', difficulty: 'advanced', description: 'A site-to-site VPN tunnel renegotiates and drops every 2-3 hours, briefly cutting connectivity. What is the diagnostic sequence?', kbSlug: 'kb-vpn' },
  { title: 'Choosing between IPsec and WireGuard for a new site-to-site link', platform: 'vpn', category: 'design', difficulty: 'intermediate', description: 'For a new site-to-site link between two small offices, what are the practical tradeoffs between IPsec and WireGuard?', kbSlug: 'kb-vpn' },
];

/** LOWER WEIGHT (weight 1): VoIP/PBX-specific questions. Kept per "no deletions" —
 * real, useful coverage, just not the owner's stated core priority. */
const NOTEBOOK_X_VOIP_PBX = [
  { title: 'Diagnosing an extension that will not register to a cloud PBX', platform: '1com', category: 'config', difficulty: 'intermediate', description: 'A phone shows "Not Registered" despite correct credentials, and was working yesterday. What is the diagnostic sequence — SIP config, firewall/NAT, portal status?', kbSlug: 'kb-1com' },
  { title: 'Diagnosing one-way audio on a cloud PBX call', platform: '1com', category: 'config', difficulty: 'intermediate', description: 'The caller cannot hear the agent after a call connects, but the agent hears the caller fine. What RTP/NAT-traversal checks isolate the cause?', kbSlug: 'kb-1com' },
  { title: 'Explaining call-queue distribution failure when agents show available', platform: '1com', category: 'queue', difficulty: 'advanced', description: 'Calls are entering a queue but no agent phone rings, though all agents show as available. What queue-strategy and SIP-trunk checks explain this?', kbSlug: 'kb-1com' },
  { title: 'Diagnosing a SIP trunk that stopped re-registering after a config change', platform: 'mirtapbx', category: 'sip', difficulty: 'intermediate', description: 'After a config update, the main SIP trunk dropped and is not re-registering. What SIP credential, outbound-proxy, and firewall-port (5060/5061) checks apply?', kbSlug: 'kb-mirtapbx' },
  { title: 'Explaining why a cluster config change is not propagating to a secondary node', platform: 'mirtapbx', category: 'cluster', difficulty: 'advanced', description: 'An extension config change made on the primary node is not reflected on the secondary. What cluster-sync/quorum checks isolate the cause?', kbSlug: 'kb-mirtapbx' },
  { title: 'Diagnosing a WebRTC softphone that fails to connect from the browser', platform: 'mirtapbx', category: 'webrtc', difficulty: 'intermediate', description: 'A browser-based softphone shows "Connection failed". What WebRTC websocket / STUN-TURN / TLS-cert checks apply?', kbSlug: 'kb-mirtapbx' },
  { title: 'Explaining SIP trunking basics for a new deployment', platform: 'voip-sip', category: 'fundamentals', difficulty: 'beginner', description: 'For a team deploying SIP trunking for the first time, what are the core concepts (registration, codecs, NAT traversal) they need to understand upfront?', kbSlug: 'kb-voip-sip' },
  { title: 'Diagnosing poor call quality on an otherwise healthy SIP trunk', platform: 'voip-sip', category: 'quality', difficulty: 'intermediate', description: 'Call quality is inconsistent (jitter, choppy audio) even though the trunk shows as registered and healthy. What is the diagnostic approach?', kbSlug: 'kb-voip-sip' },
];

/** Relative selection weight per pool. */
const POOL_WEIGHTS = {
  DATA_CENTER_CORE: 3,
  NOTEBOOK_X_CORE: 3,
  NOTEBOOK_X_VOIP_PBX: 1,
};

/** Full flat pool, each entry tagged with its target project (+ kbSlug for notebook-x). */
export const TOPIC_POOL = [
  ...DATA_CENTER_CORE.map((t) => ({ ...t, project: 'data-center', poolWeight: POOL_WEIGHTS.DATA_CENTER_CORE })),
  ...NOTEBOOK_X_CORE.map((t) => ({ ...t, project: 'notebook-x', poolWeight: POOL_WEIGHTS.NOTEBOOK_X_CORE })),
  ...NOTEBOOK_X_VOIP_PBX.map((t) => ({ ...t, project: 'notebook-x', poolWeight: POOL_WEIGHTS.NOTEBOOK_X_VOIP_PBX })),
];

export { DATA_CENTER_CORE, NOTEBOOK_X_CORE, NOTEBOOK_X_VOIP_PBX, POOL_WEIGHTS };
