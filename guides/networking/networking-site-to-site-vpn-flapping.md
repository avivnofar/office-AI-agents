<!--
Written by: The Lead QA (draft)
Finalized by: The Architect (final review + fact-check)
Date: 2026-08-06
Domain: networking
Source: topics_md:networking-site-to-site-vpn-flapping
-->

### Internal Technical Directive: Site-to-Site VPN Tunnel Stability Analysis
**Document ID:** NET-VPN-DIAG-001-REV2
**Status:** Approved for Knowledge Archive  
**Audit Scope:** Network Infrastructure / VPN Gateways  

---

#### 1. Introduction
Confidence: high

Intermittent site-to-site VPN tunnel drops occurring on a repeatable, periodic basis (e.g., every 1–8 hours) are rarely caused by physical layer failures. Instead, they typically stem from a mismatch in Security Association (SA) lifetime configurations or the premature exhaustion of keys. This guide provides a systematic methodology for isolating the root cause of tunnel instability in IPsec environments, focusing on IKE phase negotiations and keep-alive mechanisms.

---

#### 2. Phase 1: Validating Lifecycle Synchronization
Confidence: high

The most common cause for tunnels dropping at fixed intervals is a discrepancy between the `lifetime` values configured on the local and remote gateways. When the peer with the shorter lifetime initiates a rekey, a race condition can occur if the peer with the longer lifetime is not expecting the transition.

**Diagnostic Steps:**
1. **Audit Global Configuration:** Verify `isakmp` (IKEv1) or `ikev2` policy lifetimes. Ensure both peers share identical `rekey` intervals.
2. **Review Logs for Notification Messages:** Search for error logs appearing immediately before the drop. Note: While `INVALID_KE_PAYLOAD` or `NO_PROPOSAL_CHOSEN` are common in failed negotiations, they do not universally indicate a lifetime mismatch; they may also indicate phase-one proposal mismatches or DH group incompatibilities. Check logs for `LIFETIME_EXPIRED` or `SA_NEGOTIATION_FAILED` specifically.
3. **Check PFS (Perfect Forward Secrecy):** Ensure that if PFS is enabled on one side, it is explicitly enabled on the other with the identical Diffie-Hellman (DH) group. A mismatch here will cause rekey failures.

---

#### 3. Phase 2: Identifying Intermediary Interference
Confidence: high

If the tunnel remains stable during periods of high traffic but drops during idle times, the culprit is often a stateful firewall or NAT device positioned between the VPN endpoints.

**Diagnostic Steps:**
1. **UDP Timeout Analysis:** IPsec tunnels typically use UDP 500/4500. If an intermediary device has a UDP session timeout shorter than the tunnel rekey interval, the mapping will be purged, resulting in a tunnel drop when the next rekey packet is sent and blocked by the intermediary.
2. **NAT-Traversal (NAT-T):** Confirm that NAT-T is enabled on both sides. Even if no NAT exists, NAT-T encapsulates traffic in UDP, which is more reliably handled by modern stateful middleboxes than raw ESP (IP Protocol 50).
3. **Dead Peer Detection (DPD):** Audit the DPD settings. If the interval is too aggressive or the `retry` count is too low, transient network jitter might trigger an unnecessary teardown.

---

#### 4. Phase 3: Analyzing Rekeying and Traffic Selectors
Confidence: medium

For complex topologies, tunnels may drop because the Phase 2 (Quick Mode) selectors are too broad, leading to "Proxy ID" mismatches when traffic patterns shift.

**Diagnostic Steps:**
1. **Traffic Selectors (TS):** Ensure that the local and remote traffic selectors are symmetric. If one side attempts to rekey a tunnel for a dynamic traffic flow that the other side does not recognize, the IKE daemon will reject the proposal.
2. **Key Lifetime Expiration:** If the tunnel drops when a `kilobytes` limit is reached, this implies a data-volume-based rekey policy is active. *UNVERIFIED:* While some legacy hardware may experience race conditions or memory buffer issues when hitting a specific throughput limit, it is not a standard protocol behavior to drop a tunnel simply because a volume threshold is met; the device should initiate a seamless rekey. If it drops entirely, investigate potential resource exhaustion or firmware-specific bugs regarding data-volume rekeying.

---

#### 5. Phase 4: Systematic Logging and Capture
Confidence: high

When periodic drops persist, move to granular packet-level analysis.

**Diagnostic Steps:**
1. **IKE Debugging:** Enable conditional debugging for the peer IP. Focus on the `Informational Exchange` messages.
2. **Capture Strategy:** Execute a packet capture on the WAN-facing interface. Filter for the peer IP and port 500/4500. 
3. **Correlation:** Match the timestamp of the drop in the logs to the packet capture. If the peer sends a `DELETE` payload, identify if it was triggered by a local policy mismatch or a remote administrative shutdown.

---

#### 6. Concluding Analysis & Remediation
Confidence: high

To resolve periodic drops, follow this order of operations:
*   **Normalize:** Force identical SA lifetimes and DH groups across both peers.
*   **Stabilize:** Implement NAT-T and adjust DPD to "on-demand" or increase the threshold to prevent teardowns during minor jitter.
*   **Validate:** Monitor the `show crypto ipsec sa` output (or equivalent). If the tunnel drops before the counter reaches zero, the issue is an external packet filter or a session-state timeout on an intermediary device.

---

#### 7. Sources
Confidence: high

*   **RFC 7296:** Internet Key Exchange Protocol Version 2 (IKEv2). (Obsoletes RFC 4306).
*   **RFC 2409:** The Internet Key Exchange (IKE). (Primary reference for IKEv1).
*   **Cisco Systems:** "Troubleshooting IPsec VPN Phase 1 and Phase 2 Issues" (Technical Documentation).
*   **Juniper Networks:** "Understanding IPsec VPN SA Rekeying and Lifetimes" (Knowledge Base).
*   **IETF IPsecME Working Group:** Best practices for NAT-Traversal and DPD implementation.

---

**Audit Note from Agent 8:**
*Overall audit status of this workflow: Improved. The distinction between RFC 7296 and 4306 is now accurate, and speculative claims regarding volume-based drops have been appropriately labeled as unverified. Optimization suggestion: Ensure that all network engineers have pre-configured capture filters ready for rapid deployment to minimize Mean Time to Recovery (MTTR).*
