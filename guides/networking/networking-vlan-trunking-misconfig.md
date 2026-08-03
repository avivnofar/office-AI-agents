<!--
Written by: The Lead QA (draft)
Finalized by: The Architect (final review + fact-check)
Date: 2026-08-03
Domain: networking
Source: topics_md:networking-vlan-trunking-misconfig
-->

# Technical Guide: Practical VLAN Trunking and Troubleshooting

## Introduction
VLAN trunking is the foundational mechanism for multi-switch network segmentation, allowing a single physical link to carry traffic for multiple VLANs by tagging Ethernet frames with a VLAN identifier. In enterprise environments, this is primarily achieved via the IEEE 802.1Q standard. This guide details the practical implementation of trunks and addresses the most frequent cause of link failure: the Native VLAN mismatch.

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
4.  **DTP (Dynamic Trunking Protocol):** A Cisco-proprietary protocol used to auto-negotiate trunks. In high-security or stable environments, DTP should be disabled by setting ports to `switchport mode trunk` and `switchport nonegotiate`.

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

The most prevalent cause of connectivity issues between switches is a **Native VLAN Mismatch**.

### The Technical Root Cause
The Native VLAN is the segment where traffic is sent across a trunk without an 802.1Q tag. If Switch A is configured with Native VLAN 1 and Switch B is configured with Native VLAN 99, the following occurs:

1.  Switch A sends an untagged frame (intended for VLAN 1).
2.  Switch B receives the untagged frame on its trunk interface. Because Switch B's trunk port is configured for Native VLAN 99, it assumes any incoming untagged frame belongs to VLAN 99.
3.  The frame is delivered to the broadcast domain of VLAN 99.

This is a **VLAN Leak**, not a form of "VLAN Hopping." VLAN Hopping is a specific exploitation technique (e.g., switch spoofing or double-tagging) designed to bypass security controls. A native VLAN mismatch is a configuration error that causes unintended cross-segment leakage, which can lead to data exposure or broadcast domain corruption.

### Symptoms of Mismatch
*   **Connectivity Failure:** Traffic for the specific Native VLANs will fail or behave erratically, as frames intended for one segment are being injected into another.
*   **MAC Address Table Instability:** You may see the same MAC address flapping between different ports/VLANs on the switch as the switches receive traffic from the "wrong" segments.

### Resolution Strategy
Always ensure the `switchport trunk native vlan` command matches on both ends of the trunk. It is a security best practice to assign the Native VLAN to an unused, dedicated ID (a "black hole" VLAN) to ensure that accidental untagged traffic is discarded rather than bridged into a production segment.

## 4. Detection Mechanisms and Protocol Behavior
Confidence: medium

Detection of a Native VLAN mismatch relies on control-plane discovery protocols, but their behavior varies by vendor and implementation:

*   **CDP (Cisco Discovery Protocol):** Cisco switches exchange port configuration data via CDP. If the Native VLAN ID in the received CDP packet does not match the local configuration, the switch registers a mismatch. While many Cisco devices generate a notification message in this scenario, the specific naming convention of these syslog messages can vary across software versions and platforms; therefore, reliance on specific string identifiers should be verified against the local vendor documentation. (UNVERIFIED: exact message names/formats were not independently confirmed for this guide.)
*   **LLDP (Link Layer Discovery Protocol):** LLDP (IEEE 802.1AB) can carry Port VLAN ID (PVID) information in Type-Length-Value (TLV) fields. The reaction to a mismatch is not standardized. Some network operating systems may log a discrepancy in the neighbor table, while others may not propagate this information to the management plane at all. Administrators should verify the capabilities of their specific switch models regarding MIB monitoring for LLDP PVID TLV mismatches, as behavior is not consistent across all vendor hardware. (UNVERIFIED: specific vendor MIB/TLV handling was not independently confirmed for this guide.)

## 5. Summary of Best Practices
Confidence: high

*   **Hard-code Trunks:** Avoid auto-negotiation (DTP/LACP) where unnecessary to prevent unpredictable state changes.
*   **Pruning:** Explicitly define the allowed VLAN list to minimize broadcast traffic and attack surface.
*   **Native VLAN Hardening:** Use a dedicated, unused VLAN ID for the native VLAN on all trunks to prevent leakage.
*   **Documentation:** Maintain a port-level inventory detailing VLAN assignments for every inter-switch link.

## 6. Sources
Confidence: high

*   **IEEE 802.1Q-2018:** IEEE Standard for Local and Metropolitan Area Networks—Bridges and Bridged Networks.
*   **IEEE 802.1AB-2016:** Station and Media Access Control Connectivity Discovery.
*   **Cisco Systems:** *Configuration Guide for Layer 2/3 Switching (Catalyst 9000 Series)*.
*   **Juniper Networks:** *Understanding VLAN Trunking and Tagging*.
