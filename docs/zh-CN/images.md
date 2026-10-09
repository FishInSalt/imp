# 图片

当你附加或粘贴图片、使用视觉模型，或遇到图片大小限制时，读这一篇。

## read 工具如何处理图片

`read` 工具会把图片附加到对话中。当活动模型支持视觉时（claude、
gpt-4o/4.1/4.5/5、o3/o4、glm-5.3-flash/flashx、glm-5v 等），读取
jpg/png/gif/webp 会以内联方式发送图片——模型可以看见它。检测依据是内容
（魔数），从不依据文件扩展名。

- 纯文本模型也能成功读取：图片在请求时会被替换为占位符，工具会注明这一
  省略。
- BMP 会转换为 PNG（EXIF 方向信息已固化进图像）；jpg/jpeg 的 mime 标签
  会被规范化。

## 附加图片

- **打印模式**：`ink @shot.png @notes.txt "what is this"`——文本文件以
  `<file>` 块嵌入，图片经由同一处理器附加到第一条消息。
- **TUI**：Ctrl+V 会把剪贴板图片以临时文件路径的形式粘贴到光标处
  （macOS 通过 osascript，Linux 通过 wl-paste/xclip，Windows 通过
  PowerShell——Windows 暂未支持）；找不到图片时则粘贴纯文本。也可以把
  文件拖入终端，或直接输入路径。

## 超大图片处理（缩放阶梯）

超大图片（编码后 >4.5 MB）会通过 photon（Rust/WASM）缩放阶梯自动调整
大小——上限 2000×2000、PNG/JPEG 候选、质量档位、尺寸递减——并附一条
坐标映射说明，告知模型如何映射回原始像素。在 `~/.ink/settings.json` 中
设置 `images.autoResize: false` 可发送原始字节（此时超大图片会改为收到
一条教学式提示）。

## 各提供商的视觉模型

- **z.ai Coding Plan**：`glm-5.3-flash` 是该套餐的视觉模型（GLM-5.3
  本身仅支持文本）。
- Anthropic 的 claude 模型、OpenAI 的 gpt-4o/4.1/4.5/5 和 o3/o4 原生
  支持图片；见模型选择器（`/model`，Ctrl+L）——目录条目会列出
  `input: image` 能力。
