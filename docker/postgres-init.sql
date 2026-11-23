-- One role owns the tables and migrates, another serves and owns nothing, so
-- row level security binds it.
create role twake_webhook_gateway_owner login password 'owner';
create role twake_webhook_gateway login password 'gateway';
create database twake_webhook_gateway owner twake_webhook_gateway_owner;
