/**
 * Data Center — AI Agent Simulation — case generator.
 *
 * Produces IT support cases inspired by Netvill IT scenarios (netvill.co),
 * covering the categories already present in data/linux.json,
 * data/cmd.json, and data/network.json so generated cases stay solvable
 * via the live app's knowledge base.
 *
 * Status: DRAFT (Phase 1 foundation) — CASE_POOL is a representative
 * starter set; .github/workflows/agent-cases.yml expands this weekly.
 */

const CASE_POOL = [
  // linux.json categories: network, process, disk, permission, system, logs, user
  { title: 'Web service fails to bind to its configured port', platform: 'linux', category: 'network', difficulty: 'beginner', description: 'A newly deployed service refuses to start, logging "address already in use". Identify the conflicting process and resolve it.' },
  { title: 'Runaway process consuming all CPU cores', platform: 'linux', category: 'process', difficulty: 'advanced', description: 'A background job has pegged every CPU core for over an hour. Identify it, determine if it is safe to kill, and remediate.' },
  { title: 'Application crashes due to full disk', platform: 'linux', category: 'disk', difficulty: 'intermediate', description: 'An application crashes on write with "No space left on device". Find what is consuming disk space and free it safely.' },
  { title: '"Permission denied" writing to shared directory', platform: 'linux', category: 'permission', difficulty: 'beginner', description: 'A user cannot write to a shared project directory despite being in the right group. Investigate ownership, group, and ACLs.' },
  { title: 'Service fails to start after package upgrade', platform: 'linux', category: 'system', difficulty: 'intermediate', description: 'After a routine package upgrade, a critical service no longer starts. Check unit status, logs, and config compatibility.' },
  { title: 'Application log file grows without bound', platform: 'linux', category: 'logs', difficulty: 'intermediate', description: 'A service log has filled the disk overnight. Identify the cause, rotate the log, and prevent recurrence.' },
  { title: 'New employee account missing required group', platform: 'linux', category: 'user', difficulty: 'beginner', description: 'A new hire cannot access a shared resource because their account is missing from the expected group.' },

  // cmd.json categories: network, process, disk, system, user
  { title: 'Windows host cannot reach the file server', platform: 'windows', category: 'network', difficulty: 'beginner', description: 'A workstation can browse the internet but cannot reach an internal file server by hostname. Diagnose connectivity and name resolution.' },
  { title: 'Explorer.exe repeatedly crashing', platform: 'windows', category: 'process', difficulty: 'intermediate', description: 'A user reports Explorer restarting every few minutes after a Windows Update. Identify the offending process/module and restore stability.' },
  { title: 'C: drive nearly full on a workstation', platform: 'windows', category: 'disk', difficulty: 'beginner', description: 'A workstation is showing low-disk-space warnings. Identify large/unnecessary files and free space safely.' },
  { title: 'Scheduled task silently failing', platform: 'windows', category: 'system', difficulty: 'intermediate', description: 'A nightly scheduled backup task shows as "Ready" but never produces output. Diagnose why it is not running.' },
  { title: 'User locked out of domain account', platform: 'windows', category: 'user', difficulty: 'beginner', description: 'A user is locked out after multiple failed login attempts from an unfamiliar device. Investigate and unlock safely.' },

  // network.json categories: diagnostic, ports, routing, dns, firewall
  { title: 'Intermittent packet loss to a remote site', platform: 'network', category: 'diagnostic', difficulty: 'advanced', description: 'Users report intermittent slowness reaching a branch office. Trace the path and isolate where loss is occurring.' },
  { title: 'Port 443 unreachable from one VLAN only', platform: 'network', category: 'ports', difficulty: 'intermediate', description: 'A new internal HTTPS service is reachable from most VLANs but times out from one specific VLAN.' },
  { title: 'Suspected routing loop between two sites', platform: 'network', category: 'routing', difficulty: 'advanced', description: 'Two sites occasionally lose all connectivity with a spike in latency just before. A routing loop is suspected.' },
  { title: 'Internal hostnames resolve inconsistently', platform: 'network', category: 'dns', difficulty: 'intermediate', description: 'Some clients resolve an internal hostname correctly while others get NXDOMAIN. Trace the resolution path.' },
  { title: 'New service blocked by firewall on one segment', platform: 'network', category: 'firewall', difficulty: 'advanced', description: 'A newly deployed API is reachable from the server VLAN but blocked from the office VLAN. Trace the rule chain.' },

  // troubleshoot.json-style cross-platform scenarios
  { title: 'VPN tunnel drops every few hours', platform: 'cross-platform', category: 'network', difficulty: 'advanced', description: 'A site-to-site VPN tunnel renegotiates and drops every 2-3 hours, briefly cutting connectivity. Diagnose the cause.' },
  { title: 'Backup job leaves stale lock file', platform: 'cross-platform', category: 'system', difficulty: 'intermediate', description: 'A nightly backup job fails with "lock file exists" after a previous run was killed mid-job.' },
  { title: 'Time drift causing authentication failures', platform: 'cross-platform', category: 'system', difficulty: 'intermediate', description: 'Several servers are intermittently failing Kerberos/SSO authentication. Suspect clock drift between hosts.' },

  // 1COM cloud PBX cases (Netvill primary platform)
  { title: 'Extension not registering to 1COM cloud PBX', platform: '1com', category: 'config', difficulty: 'intermediate', description: 'A user phone shows "Not Registered" despite correct credentials. The extension was working yesterday. Check SIP config, firewall NAT rules, and 1COM portal status.' },
  { title: 'One-way audio on 1COM call — caller cannot hear agent', platform: '1com', category: 'config', difficulty: 'intermediate', description: 'Callers report they cannot hear the agent after the call connects. Agent hears the caller fine. Suspect RTP media path or NAT traversal issue on the 1COM trunk.' },
  { title: 'IVR routing not sending calls to the correct department', platform: '1com', category: 'ivr', difficulty: 'intermediate', description: 'After a menu option is pressed, callers are routed to the wrong queue. The IVR tree was recently updated in the 1COM portal.' },
  { title: 'Call queue not distributing calls — agents not receiving', platform: '1com', category: 'queue', difficulty: 'advanced', description: 'Calls are entering the queue but no agent phone is ringing. Agents show as available in 1COM. Check queue strategy, agent login status, and SIP trunk capacity.' },
  { title: 'Agent cannot log into the 1COM web portal', platform: '1com', category: 'config', difficulty: 'beginner', description: 'A support agent reports "Invalid credentials" on the 1COM portal despite using the correct password. Account may be locked or the role permissions changed.' },
  { title: 'Wow-Chat messages from website not appearing in 1COM', platform: '1com', category: 'omnichannel', difficulty: 'intermediate', description: 'Website chat widget is live but messages are not reaching the 1COM agent interface. The omnichannel integration may have a broken webhook or API key.' },
  { title: 'Call recordings not saving to the 1COM cloud storage', platform: '1com', category: 'monitoring', difficulty: 'intermediate', description: 'Recordings are enabled on the extension but no files appear in the 1COM recording archive. Check storage quota, recording policy, and trunk-level recording flags.' },
  { title: 'CRM popup not showing caller ID on incoming 1COM calls', platform: '1com', category: 'integration', difficulty: 'advanced', description: 'The CRM screen-pop integration stopped working. Incoming calls arrive but the CRM does not open the customer record. The 1COM API key or webhook URL may have changed.' },
  { title: 'Auto-attendant greeting playing the wrong message', platform: '1com', category: 'ivr', difficulty: 'beginner', description: 'Callers hear an outdated greeting on the main auto-attendant. The recording was updated in the 1COM portal but the old file is still playing. May need a portal cache clear or re-publish.' },
  { title: 'Extension shows offline in 1COM despite phone being powered on', platform: '1com', category: 'hardware', difficulty: 'beginner', description: 'A desk phone appears offline in the 1COM admin panel even though the physical phone is on and shows registered. Check network switch port, VLAN tagging, and PoE status.' },

  // MirtaPBX on-premise PBX cases (Netvill secondary platform)
  { title: 'SIP trunk registration failure after MirtaPBX config change', platform: 'mirtapbx', category: 'sip', difficulty: 'intermediate', description: 'After a config update in MirtaPBX admin, the main SIP trunk dropped and is not re-registering. Check SIP credentials, outbound proxy settings, and firewall ports 5060/5061.' },
  { title: 'Extension config change not propagating across the cluster', platform: 'mirtapbx', category: 'cluster', difficulty: 'advanced', description: 'An extension was modified on the primary MirtaPBX node but the change is not reflected on the secondary. Cluster sync may be failing or the secondary node is out of quorum.' },
  { title: 'Call recordings not uploading to Google Drive from MirtaPBX', platform: 'mirtapbx', category: 'recording', difficulty: 'intermediate', description: 'MirtaPBX is set to auto-upload call recordings to a Google Drive folder but uploads stopped 2 days ago. Check Google OAuth token expiry and available Drive quota.' },
  { title: 'MirtaPBX CDR report shows incorrect answered call counts', platform: 'mirtapbx', category: 'reporting', difficulty: 'intermediate', description: 'The weekly CDR report exports show far fewer answered calls than the agents actually handled. The CDR filter or timezone offset in MirtaPBX reporting may be misconfigured.' },
  { title: 'New MirtaPBX tenant not receiving inbound calls', platform: 'mirtapbx', category: 'architecture', difficulty: 'advanced', description: 'A new tenant was provisioned on the multi-tenant MirtaPBX instance but inbound DID calls reach the PBX and are rejected with a 404. The DID-to-tenant routing table needs updating.' },
  { title: 'MirtaPBX WebRTC client fails to connect from browser', platform: 'mirtapbx', category: 'webrtc', difficulty: 'intermediate', description: 'Agents using the MirtaPBX web softphone see "Connection failed" in the browser. The WebRTC websocket or STUN/TURN server configuration may have changed or the SSL cert expired.' },
  { title: 'MirtaPBX queue not routing to available agents', platform: 'mirtapbx', category: 'integration', difficulty: 'advanced', description: 'Calls enter the queue but ring out with no answer even though agents are logged in. The queue strategy is set to round-robin. Agent SIP registration status on the PBX may be stale.' },
  { title: 'MirtaPBX secondary cluster node showing as offline', platform: 'mirtapbx', category: 'cluster', difficulty: 'advanced', description: 'The MirtaPBX cluster dashboard shows the secondary node as offline. The primary is handling calls alone but failover capacity is lost. Investigate heartbeat link, disk health, and network between nodes.' },
];

function pad(n, len) {
  return String(n).padStart(len, '0');
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * @param {number} count - how many cases to generate
 * @param {object} [opts]
 * @param {number} [opts.weekNumber] - ISO week number, used in generated IDs
 * @param {number} [opts.year]
 * @param {number} [opts.startIndex] - first sequence number for IDs (default 1)
 * @returns {Array<object>} cases matching the `cases` table schema (minus auto fields)
 */
export function generateCaseBatch(count, { weekNumber, year, startIndex = 1 } = {}) {
  const now = new Date();
  const w = weekNumber ?? isoWeekNumber(now);
  const y = year ?? now.getFullYear();

  const cases = [];
  for (let i = 0; i < count; i++) {
    const template = randomItem(CASE_POOL);
    const seq = startIndex + i;
    cases.push({
      id: `case-${y}-w${pad(w, 2)}-${pad(seq, 4)}`,
      title: template.title,
      platform: template.platform,
      difficulty: template.difficulty,
      category: template.category,
      description: template.description,
      status: 'open',
    });
  }
  return cases;
}

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

export { CASE_POOL };
