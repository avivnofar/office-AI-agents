-- Data Center — AI Agent Simulation — seed data
-- Status: DRAFT. Seeds the 11 agent rows (Phase 1 active agents 1-4 +
-- Phase 2 stub agents 5-11) and a small sample batch of IT cases covering
-- categories already present in data/linux.json, data/cmd.json, and
-- data/network.json. The full weekly batch (200-300 cases) is generated
-- by .github/workflows/agent-cases.yml — this file is just enough to
-- exercise the schema locally.

INSERT INTO agents (id, key, name, tier, clearance) VALUES
  (1,  'agent-1-perfectionist', 'The Perfectionist',       'worker',     'standard'),
  (2,  'agent-2-productive',    'The Productive',          'worker',     'standard'),
  (3,  'agent-3-standard',      'The Standard Agent',      'worker',     'standard'),
  (4,  'agent-4-trainee',       'The Trainee',             'worker',     'standard'),
  (5,  'agent-5-stub',          'The Specialist',          'worker',     'standard'),
  (6,  'agent-6-stub',          'The Senior Sysadmin',     'lead',       'sudo'),
  (7,  'agent-7-stub',          'The Security Auditor',    'lead',       'sudo'),
  (8,  'agent-8-stub',          'The DevOps Engineer',     'lead',       'sudo'),
  (9,  'agent-9-stub',          'The Helpdesk Coordinator','worker',     'standard'),
  (10, 'agent-10-stub',         'The IT Director',         'management', 'root'),
  (11, 'agent-11-stub',         'The CTO',                 'management', 'root');

INSERT INTO cases (id, title, platform, difficulty, category, description, status) VALUES
  ('case-0001', 'Port 8080 already in use',            'cross-platform', 'beginner',     'ports',      'A web service fails to start because port 8080 is already bound by another process. Identify the owning process and free the port.', 'open'),
  ('case-0002', 'Disk usage at 95% on /var',           'linux',          'intermediate', 'disk',       'Monitoring alerts that /var is at 95% capacity. Find the largest consumers and reclaim space safely.', 'open'),
  ('case-0003', 'SSH connection refused after reboot', 'linux',          'intermediate', 'network',    'A server became unreachable via SSH after a scheduled reboot. Diagnose whether the service, firewall, or network is at fault.', 'open'),
  ('case-0004', 'User cannot write to shared folder',  'linux',          'beginner',     'permission', 'A user reports "Permission denied" when saving files to a shared project directory. Investigate ownership and ACLs.', 'open'),
  ('case-0005', 'High CPU usage from unknown process', 'linux',          'advanced',     'process',    'Top shows a process consuming 100% CPU with an unfamiliar name. Investigate, confirm legitimacy, and remediate.', 'open'),
  ('case-0006', 'DNS resolution intermittently fails', 'network',        'intermediate', 'dns',        'Some workstations intermittently fail to resolve internal hostnames. Trace the resolution path and identify the failing resolver.', 'open'),
  ('case-0007', 'Windows service will not start',      'windows',        'beginner',     'system',     'A Windows service fails to start after a Windows Update. Check the event log and service dependencies.', 'open'),
  ('case-0008', 'New hire account missing group access','windows',       'beginner',     'user',       'A newly created user account cannot access a shared printer and network drive expected for their department.', 'open'),
  ('case-0009', 'Firewall blocking internal API calls','network',        'advanced',     'firewall',   'A newly deployed internal API is unreachable from one VLAN but reachable from others. Trace the firewall rule chain.', 'open'),
  ('case-0010', 'Routing loop suspected between sites','network',        'advanced',     'routing',    'Two branch offices report periodic total connectivity loss with high latency just before. Suspect a routing loop.', 'open'),
  ('case-0011', 'Log file growing unbounded',          'linux',          'intermediate', 'logs',       'A service log file has grown to 40GB overnight, filling the disk. Identify the cause and rotate/cleanup safely.', 'open'),
  ('case-0012', 'Slow file transfer over VPN',         'network',        'intermediate', 'diagnostic', 'Users report very slow file transfers over the site-to-site VPN compared to direct LAN transfers. Benchmark and isolate the bottleneck.', 'open');
