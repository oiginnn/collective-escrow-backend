# Fairness MVP v1 (Provably Fair)

## Goal
Winner selection must be verifiable and not controllable by platform.

## Approach (MVP)
- Freeze participants list at close
- Use public randomness source (block hash) + lot_id + participants hash
- Winner = hash(...) mod N

## Proof
- Publish: participants list hash, randomness reference, final hash, winner index
