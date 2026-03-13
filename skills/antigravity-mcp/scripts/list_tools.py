#!/usr/bin/env python3
"""List all available tools from antigravity-mcp."""

import asyncio
import json
from pathlib import Path

async def list_tools():
    process = await asyncio.create_subprocess_exec(
        str(Path.home() / ".config/antigravity-mcp/bin/antigravity-mcp-server"),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    
    # Initialize
    init_req = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "tool-lister", "version": "1.0.0"}
        }
    }
    process.stdin.write(json.dumps(init_req).encode() + b'\n')
    await process.stdin.drain()
    init_resp = await process.stdout.readline()
    
    # List tools
    tools_req = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    }
    process.stdin.write(json.dumps(tools_req).encode() + b'\n')
    await process.stdin.drain()
    tools_resp = await process.stdout.readline()
    
    # Parse and display
    result = json.loads(tools_resp.decode().strip())
    if "result" in result and "tools" in result["result"]:
        tools = result["result"]["tools"]
        print(f"\n{'='*60}")
        print(f"Antigravity MCP - Available Tools ({len(tools)} total)")
        print(f"{'='*60}\n")
        
        for i, tool in enumerate(tools, 1):
            name = tool.get("name", "N/A")
            desc = tool.get("description", "No description")[:150]
            print(f"{i}. {name}")
            print(f"   {desc}...")
            print()
    else:
        print("Error: Unexpected response format")
        print(json.dumps(result, indent=2)[:1000])
    
    process.terminate()
    await process.wait()

if __name__ == "__main__":
    asyncio.run(list_tools())
