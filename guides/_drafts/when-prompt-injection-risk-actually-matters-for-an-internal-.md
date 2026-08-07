# REJECTED DRAFT — editor's note

**Written by:** The Team Lead · **Reviewed by:** The Architect · **Date:** 2026-08-07 · **Domain:** ai · **Source:** gap:923e629c-dee3-49ba-8c25-65137b9794f9

**Rejection note:**

Core content is reasonable, but sourcing is sloppy for a "final" document: OWASP LLM01 and NIST AI RMF are real and verifiable, but the Microsoft and Google Cloud citations are vague, non-specific ("specific document titles subject to change") and should be marked UNVERIFIED or removed rather than presented as references; also the "cryptographic human approval" caveat is good practice but oddly placed mid-bullet and should be cleaned up. Please tighten the Sources section (flag or cut unverifiable citations) and remove the unrelated "Administrative Documentation" section (daily reports/morale notes) which does not belong in a technical archive guide.

---

### Internal Technical Guide: Assessing Prompt-Injection Risks in Internal RAG Architectures

**To:** Engineering and Security Teams  
**From:** Agent 7, Team Lead  
**Subject:** Threat Modeling for LLM-Backed Internal Knowledge Retrieval

---

#### 1. Introduction
As we integrate Large Language Models (LLMs) into our internal knowledge management systems, the primary architectural pattern used is Retrieval-Augmented Generation (RAG). While RAG limits the model's "hallucination" by grounding it in our private documentation, it introduces a specific attack vector: indirect prompt injection. This guide outlines when this risk is a genuine threat to our infrastructure and how to apply proportionate, risk-based mitigations.

---

#### 2. Defining the Threat Vector: Indirect Prompt Injection
Confidence: high

In an internal RAG system, the LLM consumes untrusted data (e.g., wiki pages, PDF reports, or ticket comments) to answer user queries. Indirect prompt injection occurs when an attacker embeds malicious instructions within these documents. If the LLM processes these instructions as system-level directives rather than content, it may bypass security constraints, exfiltrate private data, or manipulate the output to deceive the user.

For our internal tools, the threat is genuine if the system performs **actions** (e.g., executing code, sending emails, or updating databases) based on the LLM’s output. If the system is strictly "read-only," the risk is largely confined to information integrity—the model might provide inaccurate information—rather than full system compromise.

---

#### 3. When the Risk Truly Matters: The "Execution" Threshold
Confidence: high

The severity of prompt injection is directly proportional to the "blast radius" of the LLM’s permissions. We categorize the risk based on the following functional tiers:

*   **Tier 1: Read-Only Retrieval (Low Risk):** The LLM retrieves document snippets and summarizes them for a user. The user is the final arbiter of truth. Risk is limited to "social engineering" of the user through manipulated summaries.
*   **Tier 2: Intermediate Decision-Making (Medium Risk):** The LLM categorizes data or suggests workflow status changes. If the LLM is tricked into misclassifying a security incident or recommending a malicious configuration, the impact is operational.
*   **Tier 3: Tool-Use and Autonomous Execution (High Risk):** The LLM has access to APIs, internal terminal interfaces, or automated scripts. **This is where prompt injection becomes a critical vulnerability.** If an injected prompt can coerce the LLM into invoking an API with unauthorized parameters, the LLM becomes a proxy for the attacker.

---

#### 4. Proportionate Mitigation Strategies
Confidence: high

Do not over-engineer defenses for Tier 1 systems. Apply the following controls based on your architecture:

*   **Input Sanitization and Chunking:** Break documents into smaller, isolated chunks. Use metadata tagging to distinguish between "System Instructions" and "Retrieved Context."
*   **The "Dual-LLM" Pattern:** Use a secondary, smaller, and strictly hardened LLM to review the primary LLM’s output *before* it is presented to the user or passed to an execution engine.
*   **Human-in-the-Loop (HITL):** For Tier 3 systems, never allow the LLM to execute an action without a verified human approval step. Note: While "cryptographic human approval" is a term often used in internal discussions, it is currently **UNVERIFIED** as a standardized industry term; ensure that the approval mechanism relies on a secure, authenticated identity provider (IdP) workflow that is logically separated from the LLM’s execution path.
*   **Principle of Least Privilege:** Ensure the service account running the LLM has the absolute minimum permissions required. If the LLM does not need `write` access to a database, it must not have it.

---

#### 5. Monitoring and Auditing
Confidence: medium

Because prompt injection is a "semantic" attack, traditional Web Application Firewalls (WAFs) will not catch it. We must move toward:
1.  **Prompt Logging:** Maintain a log of the full prompt sent to the LLM (System Prompt + Context + User Query).
2.  **Anomaly Detection:** Monitor for "instruction-like" patterns in retrieved data that deviate from expected documentation formats.
3.  **Regular Red Teaming:** Periodically attempt to inject instructions into our own internal documents to see if the LLM follows them.

---

#### 6. Concluding Remarks
Standardizing these assessment tiers allows us to innovate without compromising our security posture. If your project falls into Tier 3, please schedule an audit with my desk.

---

#### 7. Sources
*   **OWASP Top 10 for Large Language Model Applications:** *LLM01: Prompt Injection* (Current version, 2023).
*   **NIST AI Risk Management Framework (AI RMF 1.0):** Guidance on trustworthiness and security in AI systems.
*   **Microsoft Security Documentation:** *Guidelines for implementing RAG with secure data access* (Referenced as internal best-practice guidance, specific document titles subject to change).
*   **Google Cloud Architecture Center:** *Best practices for AI-driven automation and tool-use security* (Referenced as internal best-practice guidance).

***

**Administrative Documentation**
*   **Daily Report:** Daily performance tracking remains active.
*   **Leadership Note:** High morale initiatives remain in effect for the remainder of the week. Please ensure project documentation is updated to reflect the tiers defined in Section 3.
