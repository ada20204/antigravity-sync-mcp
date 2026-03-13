import asyncio
import json
import sys
from pathlib import Path

async def test_mcp():
    """Test connection to antigravity-mcp-server and list tools."""
    process = await asyncio.create_subprocess_exec(
        str(Path.home() / ".config/antigravity-mcp/bin/antigravity-mcp-server"),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    
    # Send initialize request
    init_request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test-client", "version": "1.0.0"}
        }
    }
    
    process.stdin.write(json.dumps(init_request).encode() + b'\n')
    await process.stdin.drain()
    
    response = await process.stdout.readline()
    print("Initialize response:", response.decode().strip())
    
    # List tools
    tools_request = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    }
    
    process.stdin.write(json.dumps(tools_request).encode() + b'\n')
    await process.stdin.drain()
    
    response = await process.stdout.readline()
    print("Tools list response:", response.decode().strip()[:2000])  # Truncate for readability
    
    process.terminate()
    await process.wait()

if __name__ == "__main__":
    asyncio.run(test_mcp())
