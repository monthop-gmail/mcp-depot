# Servers in the depot

Generated from `servers/*/manifest.yaml` by `npm run catalogue`. Do not edit by hand.

| Server | Status | Runtime | Data class | Tools | Owner | Summary |
|---|---|---|---|---|---|---|
| [meshcentral](../servers/meshcentral/) | experimental | site | internal | `list_groups`, `get_inventory` | @monthop-gmail | Read-only MeshCentral device groups and cached device inventory, limited to permitted device groups. |
| [rag](../servers/rag/) | experimental | site | internal | `get_status`, `list_sources`, `search`, `get_chunk`, `reindex` (write, off) | @monthop-gmail | Full-text search (Thai and English) over a site's local document folder, limited to permitted folders. |
| [zabbix](../servers/zabbix/) | experimental | site | internal | `get_active_problems`, `get_device_status`, `get_metrics` | @monthop-gmail | Read-only view of Zabbix problems, device availability and latest metrics, limited to permitted host groups. |
| [zktime](../servers/zktime/) | experimental | site | personal | `get_status`, `list_departments`, `list_devices`, `list_employees`, `list_punches`, `inspect_schema` | @monthop-gmail | Read-only view of ZKTime 5 attendance (departments, employees, clock-in/out punches, devices), limited to permitted departments. |
