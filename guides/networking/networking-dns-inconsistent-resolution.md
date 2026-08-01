<!--
Written by: The Lead QA (draft)
Finalized by: The Architect (final review + fact-check)
Date: 2026-08-01
Domain: networking
Source: topics_md:networking-dns-inconsistent-resolution
-->

# Technical Guide: Troubleshooting Inconsistent Hostname Resolution on Local Subnets

## Introduction
Inconsistent hostname resolution—where clients on the same Layer 2 broadcast domain receive differing IP mappings for the same Fully Qualified Domain Name (FQDN)—indicates a breakdown in the name resolution hierarchy or the underlying infrastructure. This guide provides a systematic methodology for auditing the resolution path, identifying points of divergence, and remediating configuration drifts.

---

## 1. Initial Scoping and Environment Verification
Confidence: High

Before initiating packet inspection, verify the consistency of the network environment. Inconsistent resolution often stems from clients utilizing different upstream DNS servers or divergent local cache states.

1.  **Check Resolver Configuration:** Ensure all clients are pointing to the same primary and secondary DNS recursive resolvers. Use `cat /etc/resolv.conf` (Linux) or `ipconfig /all` (Windows) to verify the IP addresses assigned via DHCP.
2.  **Verify Subnet Isolation:** Confirm that no hidden VLANs, secondary subnets, or proxy-ARP configurations are segmenting the broadcast domain, as these can lead to clients inadvertently reaching different gateway interfaces or DNS forwarders.
3.  **Clear Local Caches:** Eliminate local negative caching as a variable.
    *   **Windows:** `ipconfig /flushdns`
    *   **macOS:** `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`
    *   **Linux (`systemd-resolved`):** Utilize `resolvectl flush-caches`. Note: While `resolvectl` is standard in modern `systemd` distributions, the availability of specific subcommands can vary by version. If `resolvectl` is unavailable, verify your distribution's documentation for the appropriate interface to the local resolver service.

---

## 2. Analyzing the DNS Resolution Path
Confidence: High

When a client queries a hostname, the resolution follows a strict hierarchy. If the results differ, the break occurs at one of these stages:

1.  **Local Hosts File:** The client checks `/etc/hosts` or `C:\Windows\System32\drivers\etc\hosts`. Discrepancies here are a primary cause of client-specific resolution errors and are frequently overlooked.
2.  **mDNS/LLMNR/NetBIOS:** On local subnets, clients often attempt multicast resolution (mDNS) or link-local broadcast (LLMNR) before unicast DNS. If a service like Avahi or LLMNR is active, one client may receive a response via a multicast poll while others query the unicast DNS server. This creates the illusion of inconsistent DNS resolution when different resolution protocols are in play.
3.  **Unicast DNS Query:** The client sends a query to the recursive resolver. If the recursive resolver cluster lacks synchronization, the answer will vary based on which node in the cluster received the request.

---

## 3. Auditing the DNS Resolver Infrastructure
Confidence: Medium

If client configurations are uniform, the issue likely resides within the DNS infrastructure itself.

*   **Audit Forwarding Rules:** Ensure all resolvers in the cluster share identical forwarding policies. A "split-brain" DNS setup—where one resolver forwards to an internal authoritative server while another forwards to an external root hint server—is a common source of inconsistency.
*   **Check Resource Record (RR) TTLs:** If a record was recently updated, propagation delay across the resolver cluster can cause inconsistent answers. Use `dig` to compare the `TTL` values returned by different resolvers.
*   **Authoritative Zone Synchronization:** If your resolvers are also authoritative, check the serial numbers on the Primary and Secondary DNS servers. A stale zone transfer (AXFR) or an incremental zone transfer (IXFR) failure on one secondary node will cause that node to serve outdated records.

---

## 4. Identifying Divergence via Packet Analysis
Confidence: High

When manual checks fail, utilize `tcpdump` or `Wireshark` to observe the traffic.

1.  **Capture on Client:** Perform a simultaneous capture on two clients: one that resolves correctly and one that fails.
    *   `tcpdump -i any port 53 -w capture.pcap`
2.  **Compare Responses:** Inspect the DNS response flags. Look for the `RA` (Recursion Available) bit and the `AA` (Authoritative Answer) bit.
3.  **Identify Infrastructure Divergence:** If two clients query the same IP address but receive different answers, analyze the source IP of the UDP packets arriving from the DNS resolver. By identifying which specific resolver IP returned the divergent answer, you can isolate the backend node in a load-balanced cluster that is failing to synchronize or is configured incorrectly.

---

## 5. Remediation and Best Practices
Confidence: Medium

To prevent recurring inconsistency:
*   **Enforce Centralized DNS:** Disable LLMNR and NetBIOS via Group Policy (Windows) or `/etc/nsswitch.conf` (Linux) to force reliance on structured unicast DNS, eliminating non-deterministic multicast resolution.
*   **Standardize Resolver Clusters:** Use load balancers to front your DNS resolvers. While a virtual IP (VIP) provides a consistent entry point for clients, ensure backend node cache-synchronization is actively monitored; VIPs do not inherently guarantee that backend caches will remain synchronized if the backend software configuration is divergent.
*   **Monitor Propagation:** Implement automated polling using tools like `Nagios` or `Prometheus` to verify that all DNS nodes return identical records for critical internal hostnames, triggering alerts when serial number mismatches occur.

---

## Sources
*   **IETF RFC 1034:** *Domain Names - Concepts and Facilities.*
*   **IETF RFC 1035:** *Domain Names - Implementation and Specification.*
*   **Microsoft Learn:** *How DNS Works - Troubleshooting DNS clients.*
*   **ISC BIND 9 Administrator Reference Manual:** *Section 3: Name Server Operations.*
*   **systemd-resolved(8) Man Page:** *Configuration and command-line interface.*
