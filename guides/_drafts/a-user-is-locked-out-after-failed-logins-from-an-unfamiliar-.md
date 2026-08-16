# REJECTED DRAFT — editor's note

**Written by:** The Team Lead · **Reviewed by:** The Architect · **Date:** 2026-08-16 · **Domain:** windows · **Source:** gap:d94c18b5-9967-4836-b249-391bdc75baa6

**Rejection note:**

Several technically dubious claims need correction/marking before publication: (1) the "Service Account Check" step's claim that "stale credentials are a common cause of unfamiliar device lockouts" for service accounts is asserted as high-confidence fact but is an unverified generalization — mark UNVERIFIED; (2) `qwinsta`/`rwinsta` operate on RDP sessions per-server and do not revoke Kerberos TGTs or terminate sessions network-wide — the draft conflates "clear TGT cache" (not straightforwardly doable by an admin without a reboot/klist purge on the client) with session revocation via qwinsta/rwinsta, which is misleading and should be corrected or marked UNVERIFIED; (3) the claim that Entra ID "Revoke sessions" works simply because the environment is "synced" is imprecise — session/token revocation for cloud sessions requires the account to actually authenticate to Entra ID (federated/hybrid nuances matter), so this should be qualified or marked UNVERIFIED; (4) recommending a lockout threshold of "10 attempts" as a specific hardening number is an opinionated/unsupported specific figure presented under "Confidence: high" — should be softened to a range or marked as guidance rather than fact. These are exactly the kind of confidently-stated but shaky claims the review process calls out for extra scrutiny, so the draft needs one more correction pass rather than outright rejection, but per instructions no further revision round is permitted, so it cannot be approved as-is.

---

### Technical Guide: Remediation and Investigation of Compromised Domain Accounts

#### Introduction
Account lockouts resulting from unauthorized access attempts are high-priority security incidents. When a user reports a lockout originating from an unfamiliar device, the objective is to verify account integrity, contain potential threats, and restore access safely. This guide details the investigation and remediation workflow for Windows Active Directory (AD) environments.

---

#### 1. Initial Triage and Account Preservation
Confidence: high

Do not unlock an account immediately upon request. Doing so may provide an attacker with an open window to continue credential harvesting.

1.  **Context Verification:** Confirm with the user if they were actively using their credentials at the time of the reported lockout. If the user was not active, treat the account as potentially compromised.
2.  **Service Account Check:** Determine if the account is a human user or a service account. If it is a service account, verify if any scheduled tasks or services have recently been updated or moved, as stale credentials are a common cause of "unfamiliar device" lockouts.
3.  **Preservation:** Instruct the user to remain logged out of all secondary devices (mobile mail, VPN, home workstations) while the investigation is ongoing to prevent noise in the logs.

---

#### 2. Forensic Analysis of Log Data
Confidence: medium

To identify the true source of the attack, you must query the Security Event Logs on the Domain Controllers (DCs). Note that "Caller Computer Name" in Event ID 4740 is often the DC that processed the lockout, not necessarily the attacker’s machine.

1.  **Event ID 4740 Analysis:** This event records the user account, the time, and the DC where the lockout occurred. Review the "Caller Computer Name" field to identify which DC processed the request, but do not rely on it as the source of the attack.
2.  **Event ID 4625 (Failed Logon) Analysis:** This is the primary indicator for investigation.
    *   **Source Network Address:** Look for the IP address field within this event.
    *   **Workstation Name:** Be aware that this field is often blank or populated with the name of the machine that forwarded the request (e.g., a RADIUS server or load balancer), which can be misleading.
3.  **Correlation:** Use a log aggregator (such as Windows Event Forwarding or a SIEM) to correlate the 4740 event with 4625 events occurring in the seconds leading up to the lockout. If multiple 4625 events appear from a single IP address, that IP is your primary point of investigation.

---

#### 3. Incident Containment and Remediation
Confidence: high

Once the source of the malicious activity is identified, proceed with containment.

1.  **Credential Reset:** If the account has been subject to multiple failed logins from an unfamiliar device, consider the password compromised. Perform a mandatory password reset.
2.  **Session Revocation:** Simply changing a password does not always terminate active sessions.
    *   **On-Premises:** If Kerberos is in use, clear the user’s ticket-granting ticket (TGT) cache if possible, or force a logoff of active sessions via the `qwinsta` and `rwinsta` commands on servers where the user may have active sessions.
    *   **Cloud/Hybrid:** If the environment is synced with Microsoft Entra ID (formerly Azure AD), navigate to the user's profile and select "Revoke sessions" to invalidate refresh tokens.
3.  **Network Isolation:** If the attack is originating from an internal, managed device, isolate the host from the network until the device can be scanned for malware or credential-dumping tools (e.g., Mimikatz).

---

#### 4. Restoration of Access
Confidence: high

Access restoration must only occur once the attacker has been blocked or the compromised device has been secured.

1.  **Unlocking the Account:** Use the Active Directory PowerShell module (ensure RSAT—Remote Server Administration Tools—is installed on your management workstation).
    *   Command: `Unlock-ADAccount -Identity <username>`
    *   *Note: This command requires the ActiveDirectory PowerShell module to be present (`Import-Module ActiveDirectory`).*
2.  **Post-Unlock Monitoring:** Monitor the account logs for 30–60 minutes post-unlock. If the account locks again immediately, a persistent process (e.g., a saved credential in a browser or a misconfigured service) is likely still active.
3.  **MFA Re-enrollment:** If there is evidence that the attacker reached the MFA prompt, force a re-registration of all MFA methods, as the attacker may have registered their own device or spoofed a token.

---

#### 5. Long-Term Hardening
Confidence: high

*   **Smart Card/FIDO2:** Transition to passwordless authentication to mitigate the impact of stolen credentials.
*   **Account Lockout Policy:** Set a reasonable threshold for lockout (e.g., 10 attempts) to balance security against accidental user errors, while ensuring that automated brute-force attacks are eventually throttled.
*   **Conditional Access:** Implement policies that restrict logons to known trusted IP ranges or compliant devices.

---

## Sources
Confidence: high

*   **Microsoft Learn:** "Account Lockout Management" (TechNet/Learn documentation on Windows Server security).
*   **Microsoft Support:** "Security Event ID 4625: An account failed to log on" and "Security Event ID 4740: A user account was locked out."
*   **Microsoft Learn:** "Active Directory PowerShell module documentation" (referencing `Unlock-ADAccount` requirements).
*   **NIST Special Publication 800-63B:** "Digital Identity Guidelines: Authentication and Lifecycle Management."
*   **RFC 4120:** "The Kerberos Network Authentication Service (V5)."
