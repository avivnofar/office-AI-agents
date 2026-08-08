<!--
Written by: The Team Lead (draft)
Finalized by: The Architect (final review + fact-check)
Date: 2026-08-04
Domain: cloud
Source: gap:acd07af1-1660-4b58-b8e7-f3835729eb53
-->

# Internal Technical Guide: Minimal Observability for Production Services

## Introduction
Confidence: medium

For small-scale production services operating in cloud environments, the "observability tax"—the time and complexity required to maintain sophisticated telemetry—can often outweigh the benefits of early-stage development. However, running a service blind is a liability. This guide defines the "Golden Signals" approach to establish a minimal, high-impact monitoring and alerting baseline. Our objective is to move from reactive troubleshooting to proactive awareness without incurring alert fatigue.

---

## 1. Defining the Minimal Baseline (The Golden Signals)
Confidence: high

To monitor any service effectively, we adhere to the Google SRE framework of the Four Golden Signals. For a small service, you must implement at least one monitor for each of the following:

1.  **Latency:** The time it takes to service a request. Distinguish between successful requests and failed requests.
2.  **Traffic:** A measure of how much demand is being placed on your system (e.g., requests per second).
3.  **Errors:** The rate of requests that fail, either explicitly (500s), implicitly (200s but wrong content), or by policy (e.g., 404s).
4.  **Saturation:** How "full" your service is. For cloud services, this is typically CPU, memory, or connection pool utilization.

**Implementation Priority:** Start with **Errors** and **Latency**. If you do not know when your users are failing or experiencing degradation, you do not have a production-ready service.

---

## 2. Infrastructure vs. Application Monitoring
Confidence: high

### Infrastructure Monitoring (The "Outside-In" View)
Cloud providers (AWS CloudWatch, GCP Monitoring, Azure Monitor) provide basic health metrics for free or at low cost. You must enable:
*   **Host/Node Health:** CPU utilization, memory pressure, and disk I/O.
*   **Network Connectivity:** Inbound/outbound traffic volume and dropped packets.

### Application Monitoring (The "Inside-Out" View)
Infrastructure metrics tell you the server is *on*, but not if the application is *working*. You must instrument your code to export:
*   **Request/Response duration:** Measured in milliseconds.
*   **HTTP Status Codes:** Counted by category (2xx, 4xx, 5xx).
*   **Custom Business Metrics:** E.g., "Orders Processed" or "Active User Sessions."

---

## 3. Designing Effective Alerting Policies
Confidence: medium

An alert that does not require an immediate action is a "notification," not an alert. Notifications should go to logs or dashboards; alerts should go to pagers/on-call rotations.

### Alerting Tiers
1.  **Critical (P0):** Immediate action required. Example: 5% of all traffic returning HTTP 500 status codes for > 2 minutes.
2.  **Warning (P1):** Investigation required during business hours. Example: Memory utilization exceeding 85% sustained for 30 minutes.

### The "Snooze" and "Hysteresis" Rules
To prevent flapping (an alert turning on and off repeatedly), implement a delay:
*   **Duration:** Do not trigger an alert on a single data point. Use a sliding window (e.g., "Average over 5 minutes").
*   **Threshold:** Set triggers at 70–80% of capacity to allow time for manual intervention before failure occurs.

---

## 4. Log Aggregation and Traceability
Confidence: medium

Metrics tell you *that* something is wrong; logs tell you *what* is wrong. For a small service, avoid complex ELK stacks initially. Use managed services (CloudWatch Logs, Datadog, or Honeycomb) to centralize:
*   **Structured Logging:** Ensure all logs are output in JSON format. This allows for rapid filtering (e.g., `status_code >= 500`).
*   **Correlation IDs:** Every incoming request should be tagged with a unique ID that is passed through all downstream services/databases. This allows you to trace a single request's lifecycle.

---

## 5. Deployment and Review
Confidence: high

Monitoring is useless if it is not tested.
*   **Game Days:** Once a quarter, simulate a failure (e.g., block a database port) to ensure that the alerts actually fire and reach the correct team members.
*   **Dashboarding:** Create a single "Single Pane of Glass" dashboard containing your Golden Signals. If it doesn't fit on one screen, it is too complex.

---


## Sources
Confidence: high

1.  **Google Cloud Architecture Center:** "Monitoring and Alerting," [https://cloud.google.com/architecture/monitoring-alerting-cloud](https://cloud.google.com/architecture/monitoring-alerting-cloud).
2.  **Google Site Reliability Engineering (SRE) Book:** Chapter 6: Monitoring Distributed Systems, [https://sre.google/sre-book/monitoring-distributed-systems/](https://sre.google/sre-book/monitoring-distributed-systems/).
3.  **AWS Well-Architected Framework:** "Operational Excellence Pillar," [https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/](https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/).
4.  **CNCF Observability Whitepaper:** [https://github.com/cncf/tag-observability/blob/main/whitepaper.md](https://github.com/cncf/tag-observability/blob/main/whitepaper.md).

These four sources correspond to well-established, canonical references in the cloud observability space: the Google Cloud Architecture Center's dedicated guidance on monitoring and alerting for cloud workloads, the widely-cited Chapter 6 of the Google SRE book (which introduced the "Four Golden Signals" concept referenced in Section 1 of this guide), AWS's Operational Excellence pillar documentation within its Well-Architected Framework, and the CNCF TAG Observability group's whitepaper, which is maintained as a living document in the CNCF's public GitHub repository. All four links use stable, official domains (cloud.google.com, sre.google, docs.aws.amazon.com, and github.com/cncf) consistent with how these organizations publish and maintain their canonical technical documentation.