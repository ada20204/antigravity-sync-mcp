#!/usr/bin/env python3
"""Simple CLI for the local antigravity-mcp skill.

Commands:
  ping
  list-tools
  list-workspaces
  quota-status
  ask <prompt>
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

from antigravity_mcp_client import AntigravityMCPClient

REGISTRY = Path.home() / '.config' / 'antigravity-mcp' / 'registry.json'


async def call_tool(name: str, arguments: dict | None = None):
    client = AntigravityMCPClient()
    await client.connect()
    try:
        result = await client._send_request('tools/call', {
            'name': name,
            'arguments': arguments or {}
        })
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        await client.disconnect()


def read_registry_workspaces():
    if not REGISTRY.exists():
        return None
    try:
        obj = json.loads(REGISTRY.read_text(encoding='utf-8'))
    except Exception:
        return None
    return obj


async def main():
    parser = argparse.ArgumentParser(description='Antigravity MCP local CLI')
    sub = parser.add_subparsers(dest='cmd', required=True)

    sub.add_parser('ping')
    sub.add_parser('list-tools')
    sub.add_parser('list-workspaces')
    sub.add_parser('quota-status')
    ask_p = sub.add_parser('ask')
    ask_p.add_argument('prompt')
    ask_p.add_argument('-o', '--output')
    ask_p.add_argument('--target-dir')
    ask_p.add_argument('--workspace-id')
    ask_p.add_argument('--timeout-ms', type=int, default=30000)

    args = parser.parse_args()

    if args.cmd == 'ping':
        await call_tool('ping')
    elif args.cmd == 'list-tools':
        client = AntigravityMCPClient()
        await client.connect()
        try:
            result = await client._send_request('tools/list', {})
            print(json.dumps(result, ensure_ascii=False, indent=2))
        finally:
            await client.disconnect()
    elif args.cmd == 'list-workspaces':
        reg = read_registry_workspaces()
        if reg is not None:
            print(json.dumps(reg, ensure_ascii=False, indent=2))
        else:
            await call_tool('list-workspaces')
    elif args.cmd == 'quota-status':
        await call_tool('quota-status')
    elif args.cmd == 'ask':
        client = AntigravityMCPClient()
        await client.connect()
        try:
            result = await client.ask_antigravity(
                args.prompt,
                args.output,
                target_dir=args.target_dir,
                workspace_id=args.workspace_id,
                timeout_ms=args.timeout_ms,
            )
            if isinstance(result, str):
                print(result)
        finally:
            await client.disconnect()


if __name__ == '__main__':
    asyncio.run(main())
