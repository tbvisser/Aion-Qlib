FROM python:3.11-slim

# Pre-install commonly-needed libraries for sandbox code execution
RUN pip install --no-cache-dir \
    # Document generation
    python-pptx \
    python-docx \
    openpyxl \
    fpdf2 \
    # Data processing
    pandas \
    numpy \
    # Visualization
    matplotlib \
    pillow \
    # Templating & formats
    jinja2 \
    pyyaml \
    tabulate \
    # Web/utility
    requests \
    beautifulsoup4

# Create output directory used by sandbox convention
RUN mkdir -p /sandbox/output

# Install bridge client for tool access from sandbox code
COPY bridge_client.py /usr/lib/python3/bridge_client.py
ENV PYTHONPATH="/usr/lib/python3:${PYTHONPATH}"
