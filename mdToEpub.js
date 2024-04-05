const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { exec } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const { promisify } = require("util");

const execAsync = promisify(exec);

// 异步确保目录存在，如果存在，则先删除后重新创建
async function ensureDirExists(dirPath) {
  if (fs.existsSync(dirPath)) {
    // 如果目录存在，则先删除
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
  // 创建目录
  await fs.promises.mkdir(dirPath, { recursive: true });
}

// 用于将单个Markdown文件转换为HTML
async function convertMarkdownToHtmlPandoc(inputPath, outputPath) {
  try {
    await execAsync(
      `pandoc "${inputPath}" -f markdown -t html -s -o "${outputPath}"`
    );

    // 读取生成的 HTML 文件
    let htmlContent = await fs.promises.readFile(outputPath, "utf-8");

    // 添加 EPUB 命名空间声明
    htmlContent = htmlContent.replace(
      /<html>/,
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
    );

    // 将修改后的内容写回文件
    await fs.promises.writeFile(outputPath, htmlContent, "utf-8");
  } catch (error) {
    console.error(`Error converting markdown to HTML: ${error}`);
    throw error;
  }
}

async function addCoverAndResources(zip, coverImagePath, resourcePaths) {
  try {
    if (coverImagePath) {
      const coverImageContent = fs.readFileSync(coverImagePath);
      zip.file("OEBPS/images/cover.jpg", coverImageContent);
    }

    for (const resourcePath of resourcePaths) {
      const resourceName = path.basename(resourcePath);
      const resourceContent = fs.readFileSync(resourcePath);
      zip.file(`OEBPS/images/${resourceName}`, resourceContent);
    }
  } catch (error) {
    console.error("Error adding cover or resources:", error);
  }
}

function generateContentOpf(
  metadata,
  htmlFiles,
  coverImagePath,
  resourcePaths,
  uuid
) {
  let manifestItems = "";
  let spineItems = "";

  // 为每个HTML文件创建manifest项
  htmlFiles.forEach((file, index) => {
    const id = `item${index + 1}`;
    const href = `${file}`; // 确保引用的路径是正确的
    manifestItems += `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>\n`;
    spineItems += `<itemref idref="${id}"/>\n`;
  });

  // 如果存在封面图像，添加到manifest
  if (coverImagePath) {
    const coverImageName = path.basename(coverImagePath);
    manifestItems += `<item id="cover-image" href="images/${coverImageName}" media-type="image/jpeg" properties="cover-image"/>\n`;
  }

  // 添加其他资源到manifest
  resourcePaths.forEach((resourcePath, index) => {
    const resourceName = path.basename(resourcePath);
    const mediaType = "image/jpeg"; // 假设所有资源都是JPEG图像，您可能需要根据实际情况进行调整
    manifestItems += `<item id="res${
      index + 1
    }" href="images/${resourceName}" media-type="${mediaType}"/>\n`;
  });

  const now = new Date();
  const formattedDate = now.toISOString().split(".")[0] + "Z";

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>${metadata.title}</dc:title>
            <dc:creator>${metadata.author}</dc:creator>
            <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
            <dc:language>en</dc:language> <!-- 添加书籍语言 -->
            <meta property="dcterms:modified">${formattedDate}</meta>
        </metadata>
        <manifest>
            ${manifestItems}
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
            <item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        </manifest>
        <spine toc="ncx">
            ${spineItems}
        </spine>
    </package>`;

  return contentOpf;
}

function generateTocNcx(htmlFiles, titles, uuid) {
  let navPoints = "";

  htmlFiles.forEach((file, index) => {
    const id = `navPoint-${index + 1}`;
    const playOrder = index + 1;
    const navLabel = titles[index];
    const content = file;

    navPoints += `<navPoint id="${id}" playOrder="${playOrder}">
      <navLabel>
        <text>${navLabel}</text>
      </navLabel>
      <content src="${content}"/>
    </navPoint>\n`;
  });

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
  <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
    <head>
      <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
      <meta name="dtb:depth" content="1"/>
      <meta name="dtb:totalPageCount" content="0"/>
      <meta name="dtb:maxPageNumber" content="0"/>
    </head>
    <docTitle>
      <text>${metadata.title}</text>
    </docTitle>
    <navMap>
      ${navPoints}
    </navMap>
  </ncx>`;

  return tocNcx;
}

function generateTocXhtml(htmlFiles, titles) {
  let tocItems = "";

  // 假设titles数组包含了与htmlFiles对应的章节标题
  htmlFiles.forEach((file, index) => {
    const href = file;
    const title = titles[index];
    tocItems += `<li><a href="${href}">${title}</a></li>\n`;
  });

  const tocXhtml = `<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE html>
    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
    <head>
        <title>目录</title>
    </head>
    <body>
        <nav epub:type="toc" id="toc">
            <h1>目录</h1>
            <ol>
                ${tocItems}
            </ol>
        </nav>
    </body>
    </html>`;

  return tocXhtml;
}

function initializeEpubStructure(zip) {
  // 添加mimetype文件
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  // 添加container.xml文件
  // 创建EPUB必要的文件夹结构
  zip.folder("META-INF");
  zip.folder("OEBPS");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
    </container>`
  );
}

async function processMarkdownFiles(markdownDir, epubDir, htmlFiles, titles) {
  const files = fs.readdirSync(markdownDir);
  for (const file of files) {
    const filePath = path.join(markdownDir, file);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      const subDir = path.join(epubDir, file);
      fs.mkdirSync(subDir, { recursive: true });
      await processMarkdownFiles(filePath, subDir, htmlFiles, titles);
    } else if (path.extname(file) === ".md") {
      const htmlFilename = `${path.basename(file, ".md")}.xhtml`;
      const htmlFilePath = path.join(epubDir, htmlFilename);
      await convertMarkdownToHtmlPandoc(filePath, htmlFilePath);
      const filePathInEpub = path.relative(epubDir, htmlFilePath);
      htmlFiles.push(filePathInEpub);
      titles.push(path.basename(file, ".md"));
    }
  };
}

async function createEpub(markdownDir, epubPath, metadata) {
  const zip = new JSZip();
  initializeEpubStructure(zip);

  const htmlFiles = [];
  const titles = [];

  const epubDir = "OEBPS";
  await ensureDirExists(epubDir);
  await processMarkdownFiles(markdownDir, epubDir, htmlFiles, titles);

  const uuid = uuidv4();

  const contentOpf = generateContentOpf(metadata, htmlFiles, uuid);
  zip.file("OEBPS/content.opf", contentOpf);

  const tocXhtml = generateTocXhtml(htmlFiles, titles);
  zip.file("OEBPS/toc.xhtml", tocXhtml);

  const tocNcx = generateTocNcx(htmlFiles, titles, uuid);
  zip.file("OEBPS/toc.ncx", tocNcx);

  zip
    .generateAsync({ type: "nodebuffer" })
    .then((content) => {
      fs.writeFileSync(epubPath, content);
      console.log(`EPUB创建成功: ${epubPath}`);
    })
    .catch((error) => {
      console.error("EPUB创建失败:", error);
    });
}

// 示例用法
const markdownDir = "markdown/rolldown"; // 替换为实际的Markdown文件夹路径
const epubPath = "epubcheck/output.epub";
const metadata = {
  title: "电子书标题",
  author: "作者",
};

createEpub(markdownDir, epubPath, metadata);

async function createEpubFromMarkdown(
  markdownFiles,
  epubOutputPath,
  metadata,
  titles,
  coverImagePath,
  resourcePaths
) {
  const zip = new JSZip();
  initializeEpubStructure(zip);

  const htmlFiles = [];
  await ensureDirExists("OEBPS");
  for (const file of markdownFiles) {
    const htmlFilename = path.basename(file, ".md") + ".html";
    await convertMarkdownToHtmlPandoc(file, `OEBPS/${htmlFilename}`);
    const content = await fs.promises.readFile(
      `OEBPS/${htmlFilename}`,
      "utf-8"
    );
    zip.file(`OEBPS/${htmlFilename}`, content); // 确保文件路径正确
    htmlFiles.push(htmlFilename); // 修改这里以确保路径正确
  }

  await addCoverAndResources(zip, coverImagePath, resourcePaths);

  const uuid = uuidv4(); // 生成一个 UUID

  const contentOpf = generateContentOpf(
    metadata,
    htmlFiles,
    coverImagePath,
    resourcePaths,
    uuid // 将 UUID 传递给 generateContentOpf 函数
  );
  zip.file("OEBPS/content.opf", contentOpf);

  const tocXhtml = generateTocXhtml(htmlFiles, titles);
  zip.file("OEBPS/toc.xhtml", tocXhtml);

  const tocNcx = generateTocNcx(htmlFiles, titles, uuid);
  zip.file("OEBPS/toc.ncx", tocNcx);

  zip
    .generateAsync({ type: "nodebuffer" })
    .then(function (content) {
      fs.writeFileSync(epubOutputPath, content);
      console.log(`EPUB电子书已创建在 ${epubOutputPath}`);
    })
    .catch((error) => console.error("Failed to generate EPUB:", error));
}


// // 示例用法
// const markdownFiles = ["chapter1.md", "chapter2.md"]; // Markdown文件路径
// const epubOutputPath = "epubcheck-5.1.0/output.epub"; // 输出EPUB路径
// const metadata = { title: "我的电子书标题", author: "作者名" }; // 电子书元数据
// const titles = ["第一章 标题", "第二章 标题"]; // 章节标题
// const coverImagePath = "cover.jpg"; // 封面图片路径
// const resourcePaths = []; // 资源文件路径

// createEpubFromMarkdown(
//   markdownFiles,
//   epubOutputPath,
//   metadata,
//   titles,
//   coverImagePath,
//   resourcePaths
// ).catch(console.error);
