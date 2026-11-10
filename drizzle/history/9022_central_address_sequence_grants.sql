-- Grant the restricted app role access to the CAM ADRNR generator created by SCR-020.
GRANT USAGE, SELECT, UPDATE ON SEQUENCE central_address_number_seq TO cairn_app;
