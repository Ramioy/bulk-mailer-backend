# 17. Systems context

- **Tayrona** (the business writes it "Tyrona"). It is a system on SQL Server (`deb_nutibara`, tables `IN_INMUEBLES` and `IN_CONTRATOSARREN`). The contracts API (§6.1) is built by **Yoimar** on its database. It remains to be verified that `IN_CONTRATOSARREN` is the table the contract's email comes from.
- **SAP.** The `ANGLO` block corresponds to the ANGLO relationships (source S065, perimeter of 33 properties and 3 owners). The SAP API is built after the Tayrona one and exposes the same interface.
- **`mail-service`** is out of scope.
