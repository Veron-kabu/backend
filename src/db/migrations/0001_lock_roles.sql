-- Migration: Lock roles for existing users who may have switched previously
-- Sets any role values outside the allowed set (buyer, farmer, admin) back to buyer.
-- Leaves farmer/admin untouched.

BEGIN;

UPDATE users
SET role = 'buyer'
WHERE role NOT IN ('buyer','farmer','admin');

COMMIT;
