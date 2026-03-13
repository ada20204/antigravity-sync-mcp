import asyncio
import json
import sys
from pathlib import Path

async def debug_generate():
    """Debug: see what antigravity-mcp actually returns."""
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
            "clientInfo": {"name": "debug-client", "version": "1.0.0"}
        }
    }
    process.stdin.write(json.dumps(init_req).encode() + b'\n')
    await process.stdin.drain()
    init_resp = await process.stdout.readline()
    print("=== INIT RESPONSE ===")
    print(init_resp.decode().strip()[:500])
    
    # Call generate_image
    print("\n=== CALLING generate_image ===")
    call_req = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "generate_image",
            "arguments": {
                "prompt": "a cute cat",
                "size": "1024x1024"
            }
        }
    }
    process.stdin.write(json.dumps(call_req).encode() + b'\n')
    await process.stdin.drain()
    
    call_resp = await process.stdout.readline()
    print("=== RAW RESPONSE ===")
    try:
        resp_obj = json.loads(call_resp.decode().strip())
        print(json.dumps(resp_obj, indent=2)[:3000])
        
        # Check content structure
        if "result" in resp_obj and "content" in resp_obj["result"]:
            content = resp_obj["result"]["content"]
            print(f"\n=== CONTENT ITEMS: {len(content)} ===")
            for i, item in enumerate(content):
                print(f"Item {i}: type={item.get('type')}, keys={list(item.keys())}")
    except Exception as e:
        print(f"Error parsing: {e}")
        print(call_resp.decode().strip()[:1000])
    
    process.terminate()
    await process.wait()

if __name__ == "__main__":
    asyncio.run(debug_generate())
