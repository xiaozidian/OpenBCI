# Third-party components

This repository's original workbench implementation is MIT licensed. It is an independent research prototype, not an official OpenBCI product.

- **OpenBCI GUI** is installed separately by each user. This repository and its distribution package do not contain the GUI, its application JAR, or reverse-engineering evidence. See [OpenBCI GUI](https://github.com/OpenBCI/OpenBCI_GUI) for its license and releases.
- **BrainFlow** is installed with the user's OpenBCI GUI, and is used through its public Java API. BrainFlow and its native libraries are not bundled here. See [BrainFlow's license](https://github.com/brainflow-dev/brainflow/blob/master/LICENSE).
- **Java / OpenJDK** is supplied by the user's GUI installation or another Java 17+ installation. No Java runtime is redistributed.
- **Python** is installed separately. The local HTTP service uses its standard library.
- The web interface has no external font, CDN, analytics, or JavaScript dependencies. Its online demo generates samples in the browser; it does not use BrainFlow's Synthetic Board.

OpenBCI, Cyton, and Daisy names identify compatible hardware; their trademarks belong to their respective owners.
