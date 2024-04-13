const fs = require('fs-extra');
const path = require('path');
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');

async function generateTailwindCss(epubDir) {
  const styleCssPath = path.join(epubDir, 'style.css');
  const outputCssPath = path.join(epubDir, 'output.css');

  // 创建 style.css 文件并写入 Tailwind CSS 的引入语句
  const styleCssContent = `
  @tailwind base;\n@tailwind components;\n@tailwind utilities;
  `;
  await fs.writeFile(styleCssPath, styleCssContent.trim(), 'utf-8');

   // 使用 PostCSS 和 Tailwind CSS 插件处理 CSS
  const result = await postcss([
    tailwindcss({
      content: [`${epubDir}/**/*.xhtml`], // 指定要扫描的文件路径
      purge: false,
      minify: true,
    }),
  ]).process(styleCssContent, {
    from: styleCssPath,
    to: outputCssPath,
  });

  // 移除空值的自定义属性
  const cleanedCss = result.css.replace(/--tw-[\w-]+:\s*;/g, '');

  // 将生成的 CSS 内容写入 output.css 文件
  await fs.writeFile(outputCssPath, cleanedCss, 'utf-8');

  return outputCssPath;
}

module.exports = generateTailwindCss;