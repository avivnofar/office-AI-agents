# REJECTED DRAFT — editor's note

**Written by:** The Lead QA · **Reviewed by:** The Architect · **Date:** 2026-08-01 · **Domain:** networking · **Source:** topics_md:networking-dns-inconsistent-resolution

**Rejection note:**

Section 4's claim that DNS responses contain a "`Server` field" identifying which backend node answered is false (no such field exists in the DNS protocol; that's an artifact of tools like `dig` displaying the queried server's IP, not something in the response payload) — this is a fabricated technical detail presented at "Confidence: High" and must be corrected or removed, not just flagged. Additionally, the systemd-resolved command guidance (both `resolvectl` and `systemd-resolve` "commonly used," with a version-gated fallback) is asserted with unverified specificity and should be marked UNVERIFIED rather than stated as fact. Since this is the final revision pass and a materially false technical claim remains uncorrected, this must be rejected rather than approved or sent for another revision.

---

# Technical Guide: Troubleshooting Inconsistent Hostname Resolution on Local Subnets

## Introduction
Inconsistent hostname resolution—where clients on the identical Layer 2 broadcast domain receive differing IP mappings for the same Fully Qualified Domain Name (FQDN)—indicates a breakdown in the name resolution hierarchy or the underlying infrastructure. This guide provides a systematic methodology for auditing the resolution path, identifying points of divergence, and remediating configuration drifts.

---

## 1. Initial Scoping and Environment Verification
Confidence: High

Before initiating deep packet inspection, verify the consistency of the network environment. Inconsistent resolution often stems from clients utilizing different upstream DNS servers or divergent local cache states.

1.  **Check Resolver Configuration:** Ensure all clients are pointing to the same primary and secondary DNS recursive resolvers. Use `cat /etc/resolv.conf` (Linux) or `ipconfig /all` (Windows) to verify the IP addresses assigned via DHCP.
2.  **Verify Subnet Isolation:** Confirm that no hidden VLANs, secondary subnets, or proxy-ARP configurations are segmenting the broadcast domain, as these can lead to clients inadvertently reaching different gateway interfaces.
3.  **Clear Local Caches:** Eliminate local negative caching as a variable.
    *   **Windows:** `ipconfig /flushdns`
    *   **macOS:** `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`
    *   **Linux (systemd-resolved):** Both `resolvectl flush-caches` and `systemd-resolve --flush-caches` are commonly used. Use `resolvectl` on systems utilizing modern `systemd` (v239+), but fallback to `systemd-resolve` if the command is unrecognized by the host's specific distribution.

---

## 2. Analyzing the DNS Resolution Path
Confidence: High

When a client queries a hostname, the resolution follows a strict hierarchy. If the results differ, the break occurs at one of these stages:

1.  **Local Hosts File:** The client checks `/etc/hosts` or `C:\Windows\System32\drivers\etc\hosts`. Discrepancies here are a primary cause of client-specific resolution errors and are frequently overlooked.
2.  **mDNS/LLMNR/NetBIOS:** On local subnets, clients often attempt multicast resolution (mDNS) or link-local broadcast (LLMNR) before unicast DNS. If a service like Avahi or LLMNR is active, one client may receive a response via a multicast poll while others query the unicast DNS server. This creates the illusion of inconsistent DNS resolution when, in fact, different resolution protocols are in play.
3.  **Unicast DNS Query:** The client sends a query to the recursive resolver. If the recursive resolver cluster lacks synchronization, the answer will vary based on which node in the cluster received the request.

---

## 3. Auditing the DNS Resolver Infrastructure
Confidence: High

If client configurations are uniform, the issue likely resides within the DNS infrastructure itself.

*   **Audit Forwarding Rules:** Ensure all resolvers in the cluster share identical forwarding policies. A "split-brain" DNS setup—where one resolver forwards to an internal authoritative server while another forwards to an external root hint server—is a common source of inconsistency.
*   **Check Resource Record (RR) TTLs:** If a record was recently updated, propagation delay across the resolver cluster can cause inconsistent answers. Use `dig` or `nslookup` to compare the `TTL` values returned by different resolvers.
*   **Authoritative Zone Synchronization:** If your resolvers are also authoritative, check the serial numbers on the Primary and Secondary DNS servers. A stale zone transfer (AXFR) or an incremental zone transfer (IXFR) failure on one secondary node will cause that node to serve outdated records.

---

## 4. Identifying Divergence via Packet Analysis
Confidence: High

When manual checks fail, utilize `tcpdump` or `Wireshark` to observe the traffic.

1.  **Capture on Client:** Perform a simultaneous capture on two clients: one that resolves correctly and one that fails.
    *   `tcpdump -i any port 53 -w capture.pcap`
2.  **Compare Responses:** Inspect the DNS response flags. Look for the `RA` (Recursion Available) bit and the `AA` (Authoritative Answer) bit.
3.  **Identify Infrastructure Divergence:** If two clients query the same IP address but receive different answers, inspect the `Server` field in the DNS response. This confirms if the clients are hitting different backend nodes in a load-balanced resolver cluster, allowing you to isolate the specific node that is serving stale or incorrect data.

---

## 5. Remediation and Best Practices
Confidence: High

To prevent recurring inconsistency:
*   **Enforce Centralized DNS:** Disable LLMNR and NetBIOS via Group Policy (Windows) or `/etc/nsswitch.conf` (Linux) to force reliance on structured unicast DNS, eliminating non-deterministic multicast resolution.
*   **Standardize Resolver Clusters:** Use load balancers to front your DNS resolvers, ensuring clients always hit a consistent virtual IP (VIP) rather than individual backend nodes, which facilitates uniform caching behavior.
*   **Monitor Propagation:** Implement automated polling using tools like `Nagios` or `Prometheus` to verify that all DNS nodes return identical records for critical internal hostnames, triggering alerts when serial number mismatches occur.

---

## Sources
*   **IETF RFC 1034:** *Domain Names - Concepts and Facilities.*
*   **IETF RFC 1035:** *Domain Names - Implementation and Specification.*
*   **Microsoft Learn:** *How DNS Works - Troubleshooting DNS clients.*
*   **ISC BIND 9 Administrator Reference Manual:** *Section 3: Name Server Operations.*
*   **systemd-resolved(8) Man Page:** *Configuration and command-line interface.*
