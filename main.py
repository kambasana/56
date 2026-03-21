#!/usr/bin/env python3
"""NexusSocial — Multi-Agent Social Simulation Platform.

This is a convenience wrapper. The canonical entry point is:
    python -m nexus_social serve
    python -m nexus_social run --scenario "Coalition Strike" --ticks 20
    python -m nexus_social scenarios

See `python -m nexus_social --help` for all options.
"""

from nexus_social.__main__ import main

if __name__ == "__main__":
    main()
