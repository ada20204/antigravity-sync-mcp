"""
Antigravity MCP Client

High-level client for Antigravity MCP integration.
Provides image generation, code analysis, and project insights.
"""

import asyncio
import base64
import json
from pathlib import Path
from typing import Optional, Dict, Any, List
from dataclasses import dataclass

from mcp_client import MCPClient, MCPError, ConnectionError, ToolError


@dataclass
class GeneratedImage:
    """Result of image generation."""
    path: Path
    mime_type: str
    prompt: str
    
    def __str__(self):
        return f"GeneratedImage(path={self.path}, mime={self.mime_type})"


@dataclass
class CodeAnalysis:
    """Result of code analysis."""
    project_path: Path
    summary: str
    issues: List[Dict[str, Any]]
    recommendations: List[str]
    
    def to_markdown(self) -> str:
        """Convert to markdown report."""
        lines = [
            f"# Code Analysis Report\n",
            f"**Project:** `{self.project_path}`\n",
            f"## Summary\n{self.summary}\n",
            f"## Issues Found ({len(self.issues)})\n",
        ]
        for i, issue in enumerate(self.issues, 1):
            lines.append(f"{i}. **{issue.get('severity', 'info').upper()}**: {issue.get('message', 'N/A')}\n")
        
        lines.extend([
            f"\n## Recommendations\n",
        ])
        for rec in self.recommendations:
            lines.append(f"- {rec}\n")
        
        return "".join(lines)


class AntigravityClient:
    """
    High-level client for Antigravity MCP.
    
    Features:
    - Image generation
    - Code analysis
    - Project insights
    - Batch processing
    """
    
    DEFAULT_SERVER_PATH = Path.home() / ".config/antigravity-mcp/bin/antigravity-mcp-server"
    
    def __init__(
        self,
        server_path: Optional[Path] = None,
        timeout: float = 300.0,
        verbose: bool = False
    ):
        """
        Initialize Antigravity client.
        
        Args:
            server_path: Path to antigravity-mcp-server binary
            timeout: Default timeout for operations (seconds)
            verbose: Enable verbose logging
        """
        self.server_path = server_path or self.DEFAULT_SERVER_PATH
        self.timeout = timeout
        self.verbose = verbose
        self._mcp_client: Optional[MCPClient] = None
        
    async def connect(self) -> None:
        """Connect to Antigravity MCP server."""
        if self._mcp_client is not None:
            return
            
        self._mcp_client = MCPClient(
            server_command=str(self.server_path),
            timeout=self.timeout
        )
        
        try:
            await self._mcp_client.connect()
            if self.verbose:
                print(f"✅ Connected to Antigravity MCP")
        except Exception as e:
            self._mcp_client = None
            raise ConnectionError(f"Failed to connect: {e}")
    
    async def disconnect(self) -> None:
        """Disconnect from Antigravity MCP server."""
        if self._mcp_client is not None:
            await self._mcp_client.disconnect()
            self._mcp_client = None
            if self.verbose:
                print("✅ Disconnected from Antigravity MCP")
    
    async def __aenter__(self):
        """Async context manager entry."""
        await self.connect()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.disconnect()
    
    async def generate_image(
        self,
        prompt: str,
        output_path: Optional[Path] = None,
        target_dir: Optional[Path] = None,
        size: str = "1024x1024",
        quality: str = "standard"
    ) -> GeneratedImage:
        """
        Generate an image using Antigravity.
        
        Args:
            prompt: Image description/prompt
            output_path: Where to save the generated image
            target_dir: Target workspace directory
            size: Image size (e.g., "1024x1024")
            quality: Image quality ("standard" or "high")
        
        Returns:
            GeneratedImage object with path and metadata
        """
        if self._mcp_client is None:
            raise ConnectionError("Not connected. Use 'await client.connect()' first.")
        
        # Enhance prompt for image generation
        enhanced_prompt = f"请生成一张图片：{prompt}。图片尺寸 {size}，质量 {quality}。"
        
        if self.verbose:
            print(f"🎨 Generating image: {prompt}")
        
        # Build arguments
        arguments: Dict[str, Any] = {"prompt": enhanced_prompt}
        if target_dir:
            arguments["targetDir"] = str(target_dir)
        
        # Call ask-antigravity tool
        try:
            result = await self._mcp_client.call_tool(
                name="ask-antigravity",
                arguments=arguments
            )
        except ToolError as e:
            # Check if it's a CDP error that still produced an image
            if "CDP" in str(e) or "registry" in str(e):
                if self.verbose:
                    print(f"⚠️ CDP error occurred, but image may have been generated")
                # Try to find recently generated images
                # This is a fallback mechanism
            raise
        
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
                    output_path = Path(f"generated_image.{ext}")
                else:
                    output_path = Path(output_path)
                    
                # Ensure parent directory exists
                output_path.parent.mkdir(parents=True, exist_ok=True)
                
                # Save image
                image_bytes = base64.b64decode(image_data)
                with open(output_path, "wb") as f:
                    f.write(image_bytes)
                
                if self.verbose:
                    print(f"✅ Image saved to: {output_path}")
                
                return GeneratedImage(
                    path=output_path,
                    mime_type=mime_type,
                    prompt=prompt
                )
                
            elif item_type == "text":
                # Text response - might contain error or success message
                text = item.get("text", "")
                if self.verbose:
                    print(f"\n📝 Response: {text[:500]}")
                
                # Check if image was generated despite text response
                # (Sometimes images are saved to disk but not returned in response)
                recent_images = self._find_recent_images()
                if recent_images:
                    # Use the most recent image
                    latest_image = recent_images[0]
                    if self.verbose:
                        print(f"✅ Found recently generated image: {latest_image}")
                    
                    # Copy to output path if specified
                    if output_path:
                        import shutil
                        shutil.copy2(latest_image, output_path)
                        return GeneratedImage(
                            path=Path(output_path),
                            mime_type="image/png",  # Assume PNG
                            prompt=prompt
                        )
                    else:
                        return GeneratedImage(
                            path=latest_image,
                            mime_type="image/png",
                            prompt=prompt
                        )
        
        # No image found in response
        raise ToolError("No image was generated. The AI may have returned text only.")
    
    def _find_recent_images(self, max_age_seconds: int = 60) -> list:
        """Find recently generated images in Antigravity workspace."""
        brain_dir = Path.home() / ".gemini" / "antigravity" / "brain"
        if not brain_dir.exists():
            return []
        
        import time
        now = time.time()
        recent_images = []
        
        for workspace_dir in brain_dir.iterdir():
            if not workspace_dir.is_dir():
                continue
            
            for image_file in workspace_dir.glob("*.png"):
                try:
                    mtime = image_file.stat().st_mtime
                    if now - mtime < max_age_seconds:
                        recent_images.append((mtime, image_file))
                except Exception:
                    pass
        
        # Sort by modification time (most recent first)
        recent_images.sort(reverse=True)
        return [path for _, path in recent_images]
    
    async def analyze_code(
        self,
        project_path: Path,
        focus: Optional[str] = None
    ) -> CodeAnalysis:
        """
        Analyze code in a project.
        
        Args:
            project_path: Path to project directory
            focus: Specific area to focus on (e.g., "performance", "security")
        
        Returns:
            CodeAnalysis with summary, issues, and recommendations
        """
        if self._mcp_client is None:
            raise ConnectionError("Not connected. Use 'await client.connect()' first.")
        
        # Build analysis prompt
        prompt = f"请分析 {project_path} 的代码结构"
        if focus:
            prompt += f"，重点关注{focus}方面的问题"
        prompt += "。请列出：\n1. 代码结构概述\n2. 发现的问题\n3. 改进建议"
        
        if self.verbose:
            print(f"🔍 Analyzing code in: {project_path}")
        
        # Call ask-antigravity
        result = await self._mcp_client.call_tool(
            name="ask-antigravity",
            arguments={
                "prompt": prompt,
                "targetDir": str(project_path)
            }
        )
        
        # Parse result
        content = result.get("content", [])
        
        summary = ""
        issues = []
        recommendations = []
        
        for item in content:
            if item.get("type") == "text":
                text = item.get("text", "")
                summary = text[:500]  # First 500 chars as summary
                
                # Try to extract issues and recommendations
                lines = text.split("\n")
                current_section = None
                
                for line in lines:
                    if "问题" in line or "issues" in line.lower():
                        current_section = "issues"
                    elif "建议" in line or "recommendations" in line.lower():
                        current_section = "recommendations"
                    elif line.strip().startswith(("-", "*", "1.", "2.")):
                        if current_section == "issues":
                            issues.append({"message": line.strip("- *1234567890. "), "severity": "info"})
                        elif current_section == "recommendations":
                            recommendations.append(line.strip("- *1234567890. "))
        
        if not summary:
            summary = "Code analysis completed. See details below."
        
        return CodeAnalysis(
            project_path=Path(project_path),
            summary=summary,
            issues=issues,
            recommendations=recommendations
        )
