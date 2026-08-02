# REJECTED DRAFT — editor's note

**Written by:** The Lead QA · **Reviewed by:** The Architect · **Date:** 2026-08-02 · **Domain:** networking · **Source:** topics_md:networking-vlan-trunking-misconfig

**Rejection note:**

Section 3's technical explanation is factually wrong and must not pass: an untagged native-VLAN frame from Switch A (native VLAN 1) arriving at Switch B (native VLAN 99) is associated by Switch B with Switch B's native VLAN (99), meaning traffic literally crosses from VLAN 1 into VLAN 99 — the draft's narrative direction is muddled/inaccurate about which VLAN's traffic leaks where, and calling this "VLAN Hopping" conflates a distinct, specific double-tagging attack technique with a simple mismatch, which is misleading; also the CDP syslog message name (`%CDP-4-NATIVE_VLAN_MISMATCH`) and the claim that CDP "actively monitors" and generates this exact message are UNVERIFIED and stated with unwarranted "Confidence: high," so per instructions this must be flagged rather than approved as-is. Given this is the final pass and REVISE is not available, the draft cannot be approved with these unresolved, confidently-stated inaccuracies.

---

# Technical Guide: Practical VLAN Trunking and Troubleshooting

## Introduction
VLAN trunking is the foundational mechanism for multi-switch network segmentation, allowing a single physical link to carry traffic for multiple VLANs by tagging Ethernet frames with a VLAN identifier. In enterprise environments, this is primarily achieved via the IEEE 802.1Q standard. This guide details the practical implementation of trunks and addresses the most frequent cause of link failure: Native VLAN mismatch.

Confidence: high

## 1. The Mechanics of 802.1Q Tagging
Confidence: high

VLAN trunking works by inserting a 4-byte "tag" into the original Ethernet frame header. This tag contains the VLAN ID (VID), allowing receiving switches to identify the logical segment to which the frame belongs.

*   **EtherType (0x8100):** Identifies the frame as an 802.1Q tagged frame.
*   **Priority Code Point (PCP):** Used for Class of Service (CoS) traffic prioritization.
*   **Drop Eligible Indicator (DEI):** Indicates if the frame can be dropped during congestion.
*   **VLAN Identifier (VID):** A 12-bit field allowing for 4096 VLANs.

When a frame enters a trunk port, the switch tags it. When it exits an access port, the switch strips the tag, ensuring the end-device remains unaware of the underlying VLAN infrastructure.

## 2. Practical Trunk Configuration
Confidence: high

To establish a trunk between two switches, the following configuration parameters must align:

1.  **Encapsulation:** Both sides must support and use 802.1Q.
2.  **Allowed VLANs:** By default, switches allow all VLANs (1–4094). It is a security best practice to prune this list to only those VLANs required on the specific link.
3.  **Native VLAN:** The VLAN that remains untagged on a trunk link.
4.  **DTP (Dynamic Trunking Protocol):** A Cisco-proprietary protocol used to auto-negotiate trunks. In high-security or stable environments, DTP should be disabled, and ports should be set to `switchport mode trunk` and `switchport nonegotiate`.

**Configuration Example (Cisco IOS):**
```text
interface GigabitEthernet0/1
 switchport trunk encapsulation dot1q
 switchport mode trunk
 switchport trunk native vlan 99
 switchport trunk allowed vlan 10,20,99
```

## 3. The Most Common Misconfiguration: Native VLAN Mismatch
Confidence: high

The most prevalent cause of intermittent connectivity or total link failure between switches is a **Native VLAN Mismatch**.

### The Technical Root Cause
The Native VLAN is the segment where traffic is sent across a trunk without an 802.1Q tag. If Switch A is configured with Native VLAN 1 and Switch B is configured with Native VLAN 99, the following occurs:

1.  Switch A sends an untagged frame (intended for VLAN 1).
2.  Switch B receives the untagged frame. Because Switch B’s trunk port is configured for Native VLAN 99, it incorrectly associates the traffic with VLAN 99.
3.  This results in "VLAN Leaking," where traffic from one segment is injected into another, causing severe security risks and broadcast storms.

### Symptoms of Mismatch
*   **Connectivity Failure:** Traffic for the specific Native VLANs will fail, while other tagged VLANs may continue to function.
*   **MAC Address Table Instability:** You may see the same MAC address flapping between different ports/VLANs on the switch.

### Resolution Strategy
Always ensure the `switchport trunk native vlan` command matches on both ends of the trunk. Furthermore, it is a security best practice to never use VLAN 1 as the native VLAN; assign the native VLAN to a dummy, unused VLAN ID to prevent potential "VLAN Hopping" attacks.

## 4. Detection Mechanisms: CDP vs. LLDP
Confidence: high

Detection of a Native VLAN mismatch is handled by Layer 2 discovery protocols, but their implementation differs significantly:

*   **CDP (Cisco Discovery Protocol):** Cisco switches actively monitor the incoming CDP frames from neighbors. If a mismatch is detected, the switch generates a specific syslog message: `%CDP-4-NATIVE_VLAN_MISMATCH`. This is a proprietary, proactive notification.
*   **LLDP (Link Layer Discovery Protocol):** LLDP is a vendor-neutral protocol (IEEE 802.1AB). While LLDP can carry VLAN information via the Port VLAN ID (PVID) TLV, it is not universally implemented to trigger an immediate, specific syslog warning for a mismatch in the same manner as CDP. In many vendor implementations using LLDP, the mismatch is identified only through manual inspection of the neighbor management information base (MIB) or by observing traffic loss, rather than a pre-defined error message.

## 5. Summary of Best Practices
Confidence: high

*   **Hard-code Trunks:** Avoid auto-negotiation (DTP/LACP where unnecessary) to prevent unpredictable state changes.
*   **Pruning:** Explicitly define the allowed VLAN list to minimize broadcast traffic and attack surface.
*   **Native VLAN Hardening:** Move the Native VLAN off of default settings and ensure it is not used for end-user traffic.
*   **Documentation:** Maintain a port-level spreadsheet detailing VLAN assignments and trunk status for every inter-switch link.

## 6. Sources
Confidence: high

*   **IEEE 802.1Q-2018:** IEEE Standard for Local and Metropolitan Area Networks—Bridges and Bridged Networks.
*   **IEEE 802.1AB-2016:** Station and Media Access Control Connectivity Discovery.
*   **Cisco Systems:** *Configuration Guide for Layer 2/3 Switching (Catalyst 9000 Series)*.
*   **Juniper Networks:** *Understanding VLAN Trunking and Tagging*.
