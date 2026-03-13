#!/usr/bin/env python3
"""
Generate images using Antigravity MCP via ask-antigravity tool.
"""

import asyncio
import json
import sys
import argparse
import base64
from pathlib import Path


class AntigravityImageGenerator:
    """Generate images using Antigravity MCP."""
    
    def __init__(self, server_path: str = None):
        self.server_path = server_path or Path.home() / ".config/antigravity-mcp/bin/antigravity-mcp-server"
        self.process = None
        self.request_id = 0
        
    async def connect(self):
        """Start the MCP server."""
        print("🚀 Starting antigravity-mcp-server...")
        self.process = await asyncio.create_subprocess_exec(
            str(self.server_path),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        
        # Initialize
        result = await self._send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "image-generator", "version": "1.0.0"}
        })
        
        print(f"✅ Connected to {result['serverInfo']['name']} v{result['serverInfo']['version']}")
        
    async def _send_request(self, method: str, params: dict = None) -> dict:
        """Send JSON-RPC request."""
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
        
        response_line = await self.process.stdout.readline()
        response = json.loads(response_line.decode())
        
        if "error" in response:
            raise RuntimeError(f"MCP error: {response['error']}")
            
        return response.get("result", {})
        
    async def generate_image(self, prompt: str, output_path: str = None, target_dir: str = None) -> str:
        """Generate image using ask-antigravity."""
        
        # Enhance prompt for image generation
        image_prompt = f"请生成一张图片：{prompt}。请使用图像生成功能创建这张图片。"
        
        print(f"🎨 Generating image: {prompt}")
        
        # Build arguments
        arguments = {"prompt": image_prompt}
        if target_dir:
            arguments["targetDir"] = target_dir
        
        # Call ask-antigravity
        result = await self._send_request("tools/call", {
            "name": "ask-antigravity",
            "arguments": arguments
        })
        
        # Parse result
        content = result.get("content", [])
        
        for item in content:
            item_type = item.get("type")
            
            if item_type == "image":
                # Extract and save image
                image_data = item.get("data", "")
                mime_type = item.get("mimeType", "image/png")
                
                # Determine output path
                if not output_path:
                    ext = mime_type.split("/")[-1]
                    output_path = f"generated_image.{ext}"
                    
                # Save image
                image_bytes = base64.b64decode(image_data)
                with open(output_path, "wb") as f:
                    f.write(image_bytes)
                    
                print(f"✅ Image saved to: {output_path}")
                return output_path
                
            elif item_type == "text":
                # Text response
                text = item.get("text", "")
                print(f"\n📝 Response:\n{text[:500]}")
                if "image" in text.lower() or "图片" in text or "生成" in text:
                    print("\n⚠️  Image may have been generated in Antigravity app.")
                    print("Check ~/.gemini/antigravity/brain/ for saved images.")
                return text
                
        raise RuntimeError("No valid content in response")
        
    async def disconnect(self):
        """Clean up."""
        if self.process:
            self.process.terminate()
            await self.process.wait()
            

async def main():
    parser = argparse.ArgumentParser(description="Generate images using Antigravity MCP")
    parser.add_argument("prompt", help="Image generation prompt")
    parser.add_argument("-o", "--output", help="Output file path")
    parser.add_argument("--target-dir", help="Target workspace directory")
    parser.add_argument("--server-path", help="Path to antigravity-mcp-server")
    
    args = parser.parse_args()
    
    generator = AntigravityImageGenerator(server_path=args.server_path)
    
    try:
        await generator.connect()
        result = await generator.generate_image(args.prompt, args.output, args.target_dir)
        print(f"\n🎉 Success! Result: {result}")
    except Exception as e:
        print(f"\n❌ Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        await generator.disconnect()
        

if __name__ == "__main__":
    asyncio.run(main())
