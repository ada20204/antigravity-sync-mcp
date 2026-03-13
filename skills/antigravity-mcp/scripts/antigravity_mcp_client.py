#!/usr/bin/env python3
"""
Direct MCP client for Antigravity.
Uses ask-antigravity tool to generate images and execute tasks.
"""

import asyncio
import json
import sys
import argparse
import base64
import shutil
import time
from pathlib import Path


class AntigravityMCPClient:
    """MCP client for antigravity-mcp-server."""
    
    def __init__(self, server_path: str = None):
        self.server_path = server_path or Path.home() / ".config/antigravity-mcp/bin/antigravity-mcp-server"
        self.process = None
        self.request_id = 0
        
    async def connect(self):
        """Start the MCP server process."""
        self.process = await asyncio.create_subprocess_exec(
            str(self.server_path),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        
        # Wait for server to be ready
        await self._send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "antigravity-direct-client", "version": "1.0.0"}
        })
        
        print("✓ Connected to antigravity-mcp-server")
        
    async def _send_request(self, method: str, params: dict = None) -> dict:
        """Send JSON-RPC request to server."""
        self.request_id += 1
        request = {
            "jsonrpc": "2.0",
            "id": self.request_id,
            "method": method,
            "params": params or {}
        }
        
        request_line = json.dumps(request) + "\n"
        self.process.stdin.write(request_line.encode())
        await self.process.stdin.drain()
        
        # Read response
        response_line = await self.process.stdout.readline()
        response = json.loads(response_line.decode())
        
        if "error" in response:
            raise RuntimeError(f"MCP error: {response['error']}")
            
        return response.get("result", {})
        
    def _wait_for_output_path(self, output_path: str, wait_seconds: float = 25.0, poll_interval: float = 1.0) -> str | None:
        out = Path(output_path).expanduser().resolve()
        deadline = time.time() + wait_seconds
        while time.time() < deadline:
            if out.exists() and out.stat().st_size > 0:
                return str(out)
            time.sleep(poll_interval)
        return None

    def _latest_generated_image_path(self, recent_seconds: int = 180) -> str | None:
        brain = Path.home() / '.gemini' / 'antigravity' / 'brain'
        if not brain.exists():
            return None
        now = time.time()
        exts = {'.png', '.jpg', '.jpeg', '.webp'}
        candidates = []
        for p in brain.rglob('*'):
            try:
                if p.is_file() and p.suffix.lower() in exts:
                    age = now - p.stat().st_mtime
                    if age <= recent_seconds:
                        candidates.append((p.stat().st_mtime, p))
            except FileNotFoundError:
                continue
        if not candidates:
            return None
        candidates.sort(key=lambda x: x[0], reverse=True)
        return str(candidates[0][1])

    async def ask_antigravity(self, prompt: str, output_path: str = None, target_dir: str = None, workspace_id: str = None, timeout_ms: int = None) -> str:
        """Ask Antigravity AI to generate image or answer question."""

        arguments = {
            "prompt": prompt
        }
        if target_dir:
            arguments["targetDir"] = target_dir
        if workspace_id:
            arguments["workspace_id"] = workspace_id
        if timeout_ms is not None:
            arguments["timeoutMs"] = timeout_ms

        result = await self._send_request("tools/call", {
            "name": "ask-antigravity",
            "arguments": arguments
        })

        content = result.get("content", [])

        for item in content:
            item_type = item.get("type")

            if item_type == "image":
                image_data = item.get("data", "")
                mime_type = item.get("mimeType", "image/png")
                if not output_path:
                    ext = mime_type.split("/")[-1]
                    output_path = f"generated_image.{ext}"
                out = Path(output_path).expanduser().resolve()
                out.parent.mkdir(parents=True, exist_ok=True)
                image_bytes = base64.b64decode(image_data)
                with open(out, "wb") as f:
                    f.write(image_bytes)
                print(f"✓ Image saved to: {out}")
                return str(out)

            elif item_type == "text":
                text = item.get("text", "")
                print(f"\n📝 Response:\n{text[:500]}")
                if len(text) > 500:
                    print("... (truncated)")
                if output_path:
                    out = Path(output_path).expanduser().resolve()
                    out.parent.mkdir(parents=True, exist_ok=True)
                    native = self._wait_for_output_path(str(out))
                    if native:
                        print(f"✓ Native output detected at: {native}")
                        return native
                    src = self._latest_generated_image_path()
                    if src and Path(src).exists():
                        shutil.copy2(src, out)
                        print(f"✓ Copied generated file to: {out}")
                        return str(out)
                return text

        raise RuntimeError("No valid content in response")
        
    async def disconnect(self):
        """Clean up and disconnect."""
        if self.process:
            self.process.terminate()
            await self.process.wait()
            

async def main():
    parser = argparse.ArgumentParser(description="Use Antigravity AI to generate images and answer questions")
    parser.add_argument("prompt", help="Prompt for Antigravity AI (e.g., '生成一张太空猫咪的图片')")
    parser.add_argument("-o", "--output", help="Output file path for images")
    parser.add_argument("--server-path", help="Path to antigravity-mcp-server")
    
    args = parser.parse_args()
    
    client = AntigravityMCPClient(server_path=args.server_path)
    
    try:
        await client.connect()
        result = await client.ask_antigravity(args.prompt, args.output)
        print(f"\n🎉 Success!")
    except Exception as e:
        print(f"\n❌ Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        await client.disconnect()
        

if __name__ == "__main__":
    asyncio.run(main())
