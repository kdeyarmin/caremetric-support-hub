# Intel live administration bridge

The verified Intel public runtime is Base44 app `6993c62145573ca8a97ad4a9`.
The source repository's Express migration is not a verified production target.
The reviewed hosted bridge lives in `kdeyarmin/intel` and provides capabilities,
registered-user overview and directory only. Organizations and active-account
totals are explicitly unavailable; no billing operation is advertised.

The Hub uses the fixed `https://caremetricintel.com/functions/centralAdminRead`
destination and `X-CareMetric-Hub-Authorization`. Only the current app-owned SMS
session can issue a one-use `intel` capability. Legacy JWT proxy requests stop
before forwarding. The native bridge rechecks its separately reviewed native
administrator map and current protected Base44 role.

Apply `20260911184616_hub_intel_admin_audience.sql` before this runtime. The
constraint preserves Go, publication, learning, command and media audiences.
Deploy only the exact reviewed named Intel function, confirm the live runtime,
and keep it disabled until native-owner identity mapping is verified. A deployed
function alone is not proof of a working authorized connection.
