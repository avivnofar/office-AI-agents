# REJECTED DRAFT — editor's note

**Written by:** The Lead QA · **Reviewed by:** The Architect · **Date:** 2026-08-11 · **Domain:** networking · **Source:** gap:c2dfe746-546e-499e-9b39-6b2be5c27b04

**Rejection note:**

One residual factual problem: "sudo systemd-resolve --flush-caches" — the legacy tool was named `systemd-resolve` and its flush flag was actually `--flush-caches`, but this binary was deprecated/removed in favor of `resolvectl` in newer systemd releases, so calling it "still widely supported" is questionable and should be marked UNVERIFIED rather than asserted under a "Confidence: high" section; also double-check that `dig @server host +norecurse` behaves as described for authoritative-only servers (it's correct only if the server is not itself recursive) — this nuance should be clarified rather than stated flatly. Please adjust these two points and resubmit framing (mark unverifiable claims explicitly) since this is a hard requirement, not optional polish.

---

# Technical Guide: Troubleshooting Intermittent DNS Resolution on Homogeneous Subnets

## Introduction
In a production network environment, DNS consistency is the bedrock of service discovery. When clients on the same subnet exhibit disparate resolution results for an identical internal hostname—specifically where some receive valid A/AAAA records and others receive `NXDOMAIN`—the issue typically points to a failure in the distributed nature of the DNS resolution path rather than the network layer itself. This guide outlines a systematic methodology for tracing the resolution path, isolating state-dependent failures, and validating the integrity of the DNS hierarchy.

---

## 1. Establishing the Baseline: Client-Side Environment
Confidence: high

Before tracing packets, you must audit the local resolution environment of both the "working" and "failing" hosts. DNS resolution is rarely a direct query to the authoritative source; it is a layered process involving local caches and forwarders.

1.  **Local Resolver Configuration:** Inspect `/etc/resolv.conf` (Linux) or `ipconfig /all` (Windows). Identify if clients are pointing to identical recursive resolvers. If the subnets share the same gateway, verify if DHCP options are pushing consistent DNS server addresses.
2.  **DNS Cache State:** Clients maintain local caches (e.g., `systemd-resolved`, `nscd`, or the Windows DNS Client service). A failing client may hold a "negative cache" entry (the `NXDOMAIN` result) from a previous transient failure.
    *   *Action:* Clear the cache. On modern Linux systems using `systemd-resolved`, use `resolvectl flush-caches`. On legacy systems or those using `systemd-resolve` directly, `sudo systemd-resolve --flush-caches` is still widely supported. On Windows, use `ipconfig /flushdns`.
3.  **Search Domains:** Check for domain suffix search lists. If an internal hostname is resolved without a Fully Qualified Domain Name (FQDN), the client may be appending search suffixes in an order that causes the query to fail on some clients but succeed on others due to local configuration drift.

---

## 2. Path Tracing: The Packet Journey
Confidence: medium

To diagnose why some clients receive `NXDOMAIN`, you must move from the endpoint to the wire. Use `dig` or `nslookup` with query tracing enabled to visualize the delegation chain.

1.  **Direct Querying:** Bypass local resolvers to test the upstream server directly:
    `dig @<DNS_SERVER_IP> <HOSTNAME> +norecurse`
    If this succeeds while the client’s standard lookup fails, the issue is not the authoritative server, but the recursive path.
2.  **Tracing the Delegation:** Use `dig +trace <HOSTNAME>`. Note that for internal or split-horizon zones, `dig +trace` may provide misleading results because it attempts to follow the global DNS hierarchy starting from the root hints, which may not be aware of your internal private zones. Use this tool primarily to verify the delegation of public-facing zones.
3.  **Anycast vs. Unicast:** If your infrastructure uses Anycast, the "failing" clients may be hitting a different physical instance of the DNS server than the "working" clients. 
    *   *Action:* Use `traceroute` or `mtr` to the DNS server IP. While this confirms the path to the server, it is an indirect metric; it does not guarantee that the physical hardware is the root cause of the DNS-level discrepancy, though it confirms if traffic is being routed to different infrastructure nodes.

---

## 3. Investigating Recursive Forwarders and Load Balancers
Confidence: medium

In many enterprise environments, clients query a load-balanced set of recursive forwarders. 

1.  **State Mismatch:** If your recursive forwarders are load-balanced, they may have different caches. If the authoritative zone updated recently, one forwarder may be serving the new record while another serves the old (cached) `NXDOMAIN` response.
2.  **Health Check Failures:** Check the load balancer health metrics. If one recursive forwarder is failing health checks but still receiving traffic, it may be unable to reach the upstream authoritative servers, leading to consistent failure for any client hitting that specific node.
3.  **DNSSEC Validation (UNVERIFIED):** If DNSSEC is enabled, validation failures on the recursive forwarder may result in an `NXDOMAIN` or a `SERVFAIL`. Note that behavior varies significantly by resolver implementation; some resolvers return `NXDOMAIN` to mask validation errors for security, while others return `SERVFAIL`. Check if the failing clients are hitting a server that is failing to validate the RRSIG/DNSKEY chain for the internal zone.

---

## 4. Analyzing Internal Zone Synchronization
Confidence: high

If the authoritative servers are not correctly synchronized, the "NXDOMAIN" result is a symptom of data inconsistency.

1.  **Zone Transfer Monitoring:** Check logs for `named` or `CoreDNS` regarding zone transfer failures. A secondary server that has not updated its serial number will continue to serve stale data (or lack of data).
2.  **Hidden Master/Slave Architecture:** Many internal environments use a hidden primary server. Ensure that the secondary servers are receiving `NOTIFY` opcodes and successfully performing serial checks.
3.  **Split-Horizon DNS:** If using split-horizon, ensure the "internal" view is correctly scoped to the subnets in question. A client on a subnet that is not defined in the ACL for the "internal" view will fall back to the "external" (or global) view, which often lacks internal host records.

---

## 5. Summary of Diagnostic Workflow
Confidence: high

When encountering inconsistent resolution, follow this order of operations:
1.  **Verify client config:** Ensure DNS server IPs and search domains are uniform.
2.  **Clear caches:** Rule out negative caching using `resolvectl` or `ipconfig`.
3.  **Bypass recursion:** Direct query the authoritative source to isolate recursion issues.
4.  **Check infrastructure:** Verify Anycast routing and load balancer node health.
5.  **Audit synchronization:** Confirm the authoritative zone serial numbers are identical across all DNS nodes.

---

## Sources
*   **RFC 1034/1035:** Domain Names - Concepts and Facilities / Implementation and Specification.
*   **RFC 4033/4034/4035:** DNS Security Introduction and Requirements.
*   **BIND 9 Administrator Reference Manual (ARM):** Section on Zone Transfers and View-based ACLs.
*   **systemd-resolved(8) Man Page:** Documentation regarding `resolvectl` and cache management.
*   **Microsoft TechNet:** Troubleshooting DNS Client and Resolver Cache issues.
