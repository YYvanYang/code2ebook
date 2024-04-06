const fs = require("fs");
const path = require("path");
const async = require("async");
const JSZip = require("jszip");
const { exec, execSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const { promisify } = require("util");

const execAsync = promisify(exec);

async function ensureDirectoryExists(dirPath) {
  try {
    await fs.promises.access(dirPath);
  } catch (error) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }
}

async function cleanDirectory(directory) {
  if (fs.existsSync(directory)) {
    if (process.platform === "win32") {
      fs.rmSync(directory, { recursive: true });
    } else {
      execSync(`rm -rf ${directory}`);
    }
  }
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
      await ensureDirectoryExists("OEBPS/images");
      zip.file("OEBPS/images/cover.jpg", coverImageContent);
    }

    for (const resourcePath of resourcePaths) {
      const resourceName = path.basename(resourcePath);
      const resourceContent = fs.readFileSync(resourcePath);
      await ensureDirectoryExists("OEBPS/images");
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

function countMarkdownFiles(directory) {
  let count = 0;
  const files = fs.readdirSync(directory);
  for (const file of files) {
    const filePath = path.join(directory, file);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      count += countMarkdownFiles(filePath);
    } else if (path.extname(file) === ".md") {
      count++;
    }
  }
  return count;
}

async function processImageReferences(
  zip,
  markdownDir,
  epubDir,
  markdownFilePath
) {
  const markdownContent = await fs.promises.readFile(markdownFilePath, "utf-8");
  const pattern = /!\[[^\]]*\]\((.*?)\)/g;
  const matches = markdownContent.match(pattern);

  if (matches) {
    const epubBaseDir = "OEBPS";
    for (const match of matches) {
      const imagePath = match.match(/\((.*?)\)/)[1];
      const normalizedImagePath = path.normalize(imagePath);
      const absoluteImagePath = path.join(markdownDir, normalizedImagePath);

      // 检查原图片资源是否存在
      if (fs.existsSync(absoluteImagePath)) {
        const imageDestPath = path.join(
          epubBaseDir,
          "images",
          path.basename(normalizedImagePath)
        );

        // 确保目标目录存在
        await fs.promises.mkdir(path.dirname(imageDestPath), {
          recursive: true,
        });

        await fs.promises.copyFile(absoluteImagePath, imageDestPath);
        console.log(`复制图片: ${normalizedImagePath} -> ${imageDestPath}`);
        // replace backslashes with forward slashes
        const imageDestPathNormalized = imageDestPath.replace(/\\/g, "/");
        zip.file(imageDestPathNormalized, fs.readFileSync(imageDestPath));
      } else {
        console.warn(`图片不存在: ${absoluteImagePath}`);
      }
    }
  }
}

async function processMarkdownFiles(
  zip,
  markdownDir,
  epubDir,
  htmlFiles,
  titles,
  processedFiles
) {
  const files = fs.readdirSync(markdownDir);
  const markdownFiles = files.filter((file) => path.extname(file) === ".md");

  const convertQueue = async.queue(async (file, callback) => {
    const filePath = path.join(markdownDir, file);
    const htmlFilename = `${path.basename(file, ".md")}.xhtml`;
    const htmlFilePath = path.join(epubDir, htmlFilename);
    console.log(`转换Markdown文件: ${filePath}`);
    await convertMarkdownToHtmlPandoc(filePath, htmlFilePath);

    // 处理 Markdown 文件中的图片引用
    await processImageReferences(zip, markdownDir, epubDir, filePath);

    let htmlFileFullName = path.join(epubDir, htmlFilename);
    // replace backslashes with forward slashes
    htmlFileFullName = htmlFileFullName.replace(/\\/g, "/");
    const htmlFileRelativePath = path.relative(epubDir, htmlFilename);
    console.log(
      `添加文件到EPUB: `,
      htmlFileFullName,
      htmlFileRelativePath,
      htmlFilePath,
      htmlFilename
    );
    try {
      const content = await fs.promises.readFile(htmlFileFullName, "utf-8");
      zip.file(htmlFileFullName, content); // 确保文件路径正确
    } catch (error) {
      console.error(`Error adding file to EPUB: ${error}`);
    }

    htmlFiles.push(htmlFileFullName.replace("OEBPS/", ""));
    titles.push(path.basename(file, ".md"));
    processedFiles.count++;
    const percentage = (
      (processedFiles.count / processedFiles.total) *
      100
    ).toFixed(2);
    console.log(
      `转换进度: ${processedFiles.count}/${processedFiles.total} (${percentage}%)`
    );
    callback();
  }, 1);

  convertQueue.push(markdownFiles);

  await new Promise((resolve) => {
    convertQueue.drain(resolve);
  });

  for (const file of files) {
    const filePath = path.join(markdownDir, file);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      const subDir = path.join(epubDir, file);
      fs.mkdirSync(subDir, { recursive: true });
      console.log(`创建子目录: ${subDir}`);
      await processMarkdownFiles(
        zip,
        filePath,
        subDir,
        htmlFiles,
        titles,
        processedFiles
      );
    }
  }
}

async function createEpub(
  markdownDir,
  epubPath,
  metadata,
  coverImagePath,
  resourcePaths = []
) {
  console.log("开始创建EPUB...");

  const zip = new JSZip();
  initializeEpubStructure(zip);

  const htmlFiles = [];
  const titles = [];

  const epubDir = "OEBPS";
  console.log(`创建EPUB目录: ${epubDir}`);
  await cleanDirectory(epubDir);
  await ensureDirectoryExists(epubDir);

  console.log("处理Markdown文件...");
  const totalFiles = countMarkdownFiles(markdownDir);
  const processedFiles = { count: 0, total: totalFiles };
  await processMarkdownFiles(
    zip,
    markdownDir,
    epubDir,
    htmlFiles,
    titles,
    processedFiles
  );

  await addCoverAndResources(zip, coverImagePath, resourcePaths);

  console.log("生成content.opf...");
  const uuid = uuidv4();
  const contentOpf = generateContentOpf(
    metadata,
    htmlFiles,
    coverImagePath,
    resourcePaths,
    uuid
  );
  zip.file("OEBPS/content.opf", contentOpf);

  console.log("生成toc.xhtml...");
  const tocXhtml = generateTocXhtml(htmlFiles, titles);
  zip.file("OEBPS/toc.xhtml", tocXhtml);

  console.log("生成toc.ncx...");
  const tocNcx = generateTocNcx(htmlFiles, titles, uuid);
  zip.file("OEBPS/toc.ncx", tocNcx);

  console.log("生成EPUB文件...");
  zip
    .generateAsync({ type: "nodebuffer" })
    .then((content) => {
      fs.writeFileSync(epubPath, content);
      console.log(`EPUB创建成功: ${epubPath}`);
      console.log("开始校验EPUB...");
      return validateEpub(epubPath);
    })
    .catch((error) => {
      console.error("EPUB创建失败:", error);
    });
}

async function validateEpub(epubPath) {
  try {
    const { stdout, stderr } = await execAsync(
      `java -jar epubcheck/epubcheck.jar "${epubPath}"`
    );
    console.log("EPUBCheck 校验结果:");
    console.log(stdout);
    if (stderr) {
      console.error("EPUBCheck 错误:");
      console.error(stderr);
    }
  } catch (error) {
    console.error("EPUBCheck 执行失败:", error);
  }
}

// 示例用法
const markdownDir = "markdown/mdExample"; // 替换为实际的Markdown文件夹路径
const epubPath = "output.epub";
const metadata = {
  title: "电子书标题",
  author: "作者",
};

// const coverImagePath = "cover.jpg"; // 封面图片路径
// const resourcePaths = ["OEBPS/images"]; // 资源文件路径

createEpub(
  markdownDir,
  epubPath,
  metadata
  // coverImagePath,
  // resourcePaths
).catch(console.error);

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
  await cleanDirectory("OEBPS");
  await ensureDirectoryExists("OEBPS");
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
