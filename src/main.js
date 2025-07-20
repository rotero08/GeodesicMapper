// src/main.js
import * as d3 from 'd3';
import * as topojson from 'topojson-client';

// Get canvas and context using d3.select for consistency
const canvasWrapper = d3.select("#globe-canvas-wrapper");
const canvas = d3.select("#globe-canvas");
const context = canvas.node().getContext('2d'); // Get native context from D3 selection
const toggleButton = document.getElementById('projection-toggle');


if (!canvas.node() || !toggleButton || !canvasWrapper.node()) {
    console.error("Required DOM elements (canvas, toggle button, or canvas wrapper) not found!");
} else {
    // --- Global Variables ---
    let projection;
    let path;
    let countries = null; // Variable to hold countries GeoJSON data

    // Projection parameters (initial values)
    const orthographicRotate = [10, -20, 0];
    let orthographicScale; // Will be calculated dynamically
    const mercatorRotate = [0, 0, 0];
    let mercatorScale; // Will be determined by fitSize
    let mercatorTranslate; // Will be determined by fitSize

    let animationId = null;
    let isAnimating = false;
    let currentProjectionState = 0; // 0: orthographic, 1: mercator

    // --- Helper function to interpolate between two raw projections ---
    function interpolateProjection(raw0, raw1) {
        const mutate = d3.geoProjectionMutator(t => (x, y) => {
            const [x0, y0] = raw0(x, y);
            const [x1, y1] = raw1(x, y);
            return [x0 + t * (x1 - x0), y0 + t * (y1 - y0)];
        });
        let t = 0;
        return Object.assign(mutate(t), {
            alpha(_) {
                return arguments.length ? mutate(t = +_) : t;
            }
        });
    }

    // --- Geographic Data Definitions ---
    const equator = { type: "LineString", coordinates: [[-180, 0], [-90, 0], [0, 0], [90, 0], [180, 0]] };
    const sphere = { type: "Sphere" };
    const graticule = d3.geoGraticule10();
    const diagonalLine = {
        type: "LineString",
        coordinates: [[-150, -60], [-75, -30], [0, 0], [75, 30], [150, 60]]
    };

    /**
     * Calculates Mercator projection parameters dynamically based on current canvas size.
     * Uses d3.geoMercator().fitSize() to ensure the world map fits perfectly.
     */
    function calculateMercatorParams() {
        const currentWidth = +canvas.attr("width");
        const currentHeight = +canvas.attr("height");

        const tempMercatorProjection = d3.geoMercator()
            .precision(0.1);

        // Fit the entire sphere (world) into the current canvas dimensions
        tempMercatorProjection.fitSize([currentWidth, currentHeight], sphere);

        mercatorScale = tempMercatorProjection.scale();
        mercatorTranslate = tempMercatorProjection.translate();
    }

    /**
     * Updates canvas dimensions and projection parameters on resize.
     * This is the core of the responsive logic.
     */
    function updateDimensions() {
        // Get dimensions from the *wrapper* element
        let newWidth = canvasWrapper.node().clientWidth;
        let newHeight = canvasWrapper.node().clientHeight;

        // Only update if dimensions have actually changed to prevent unnecessary redraws
        if (+canvas.attr("width") !== newWidth || +canvas.attr("height") !== newHeight) {
            // Set canvas attributes (which define the drawing surface size)
            canvas.attr("width", newWidth);
            canvas.attr("height", newHeight);
            
            // Re-calculate orthographic scale based on new dimensions
            orthographicScale = Math.min(newWidth, newHeight) / 2 - 10// Adjusted to fit with some padding

            // Re-calculate Mercator parameters for the new size
            calculateMercatorParams();

            // Initialize or update the main projection object and path generator
            if (!projection) {
                projection = interpolateProjection(d3.geoOrthographicRaw, d3.geoMercatorRaw)
                    .precision(0.1);
            }
            path = d3.geoPath(projection, context);

            // Set the projection's scale and translate based on the current state and new dimensions
            projection.scale(currentProjectionState === 0 ? orthographicScale : mercatorScale);
            projection.translate(currentProjectionState === 0 ? [newWidth / 2, newHeight / 2] : mercatorTranslate);
            projection.rotate(currentProjectionState === 0 ? orthographicRotate : mercatorRotate); // Ensure rotation is reset/set correctly

            // Re-render the globe with the updated parameters
            if (countries) { // Only render if countries data is already loaded
                renderFrame(currentProjectionState);
            }
        }
    }

    /**
     * Renders a single frame of the globe.
     * @param {number} interpolatedT - The interpolation factor (0 to 1) for blending orthographic to mercator.
     * 0 for pure orthographic, 1 for pure mercator.
     */
    function renderFrame(interpolatedT) {
        const currentWidth = +canvas.attr("width");
        const currentHeight = +canvas.attr("height");

        // Interpolate rotation, scale, and translate
        const interpolatedRotate = d3.interpolate(orthographicRotate, mercatorRotate)(interpolatedT);
        const interpolatedScale = d3.interpolate(orthographicScale, mercatorScale)(interpolatedT);
        const interpolatedTranslate = d3.interpolate([currentWidth / 2, currentHeight / 2], mercatorTranslate)(interpolatedT);

        // Apply interpolated projection parameters
        projection
            .alpha(interpolatedT)
            .rotate(interpolatedRotate)
            .scale(interpolatedScale)
            .translate(interpolatedTranslate);

        // Clear canvas
        context.clearRect(0, 0, currentWidth, currentHeight);

        // --- DRAW ORDER: Countries (fill all), then Sphere/Lines ---

        // Apply clipping for countries during the first half of the transition
        if (interpolatedT <= 0.5) { // Orthographic part of transition (0 to 0.5)
            // Clip angle starts at 90 (hemisphere) and expands to 180 (full sphere)
            const countryClipAngle = 90 + (interpolatedT * 2) * 90;
            projection.clipAngle(countryClipAngle);
        } else { // Mercator part of transition (0.5 to 1)
            projection.clipAngle(null); // No clipping for Mercator countries
        }

        // Draw countries
        if (countries) {
            context.beginPath();
            path(countries);
            context.fillStyle = "#336699"; // Blue color for countries
            context.fill();
            context.lineWidth = 0.5;
            context.strokeStyle = "#ffffff"; // White borders
            context.stroke();
        }

        // --- Apply clipping for graticule, equator, and diagonal line ---
        // These lines should generally fade out or become less prominent as the Mercator projection is fully visible.
        // Or, if always visible, they should only be clipped when the globe is purely Orthographic.
        // For simplicity, we'll keep a similar clipping logic to countries for a smooth unfold.
        // A more nuanced approach might use opacity or different clip logic based on what you want to show.
        let lineClipAngle;
        if (interpolatedT <= 0.5) {
             // Lines also unfold from 90 to 180
            lineClipAngle = 90 + (interpolatedT * 2) * 90;
        } else {
            // No clipping for lines in Mercator view
            lineClipAngle = 180;
        }
        projection.clipAngle(lineClipAngle);


        // Draw graticule
        context.beginPath();
        path(graticule);
        context.lineWidth = 0.5;
        context.strokeStyle = "rgba(255, 255, 255, 0.2)";
        context.stroke();

        // Draw sphere outline (visible in orthographic view, less meaningful in Mercator)
        context.beginPath();
        path(sphere);
        context.lineWidth = 1.5;
        context.strokeStyle = "#fff"; // White outline for sphere
        context.stroke();

        // Draw equator (visibility controlled by clipAngle)
        context.beginPath();
        path(equator);
        context.lineWidth = 2;
        context.strokeStyle = "#ff4444"; // Red line for equator
        context.stroke();

        // Draw the diagonal line
        context.beginPath();
        path(diagonalLine);
        context.lineWidth = 2; // Make it a bit thicker
        context.strokeStyle = "#00FF00"; // Green color for visibility
        context.stroke();
    }

    /**
     * Animates the projection transition.
     * @param {number} targetState - The desired final projection state (0 for ortho, 1 for mercator).
     */
    function animateProjection(targetState) {
        if (isAnimating) return;
        isAnimating = true;
        toggleButton.disabled = true;

        const duration = 1500; // milliseconds
        const ease = d3.easeCubicInOut;
        let startTime = null;

        const startT = currentProjectionState;
        const endT = targetState;

        function loop(currentTime) {
            if (!startTime) startTime = currentTime;
            const elapsed = currentTime - startTime;
            let tProgress = Math.min(1, elapsed / duration);

            const interpolatedFactor = startT + (endT - startT) * ease(tProgress);

            renderFrame(interpolatedFactor);

            if (elapsed < duration) {
                animationId = requestAnimationFrame(loop);
            } else {
                isAnimating = false;
                toggleButton.disabled = false;
                currentProjectionState = targetState;
                renderFrame(targetState); // Ensure final state is rendered precisely
            }
        }
        animationId = requestAnimationFrame(loop);
    }

    /**
     * Toggles the projection between orthographic and mercator.
     */
    function transformProjection() {
        if (isAnimating) return;

        if (currentProjectionState === 0) { // Currently orthographic, transform to mercator
            animateProjection(1); // Target state is 1 (mercator)
        } else { // Currently mercator, transform back to orthographic
            animateProjection(0); // Target state is 0 (orthographic)
        }
    }

    // --- Data Loading and Initialization ---
    // Load world data and then initialize the globe
    d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json").then(world => {
        countries = topojson.feature(world, world.objects.countries);
        console.log("Countries data loaded:", countries);

        // Initial setup of dimensions and projection after data is loaded
        updateDimensions();

        // Initial render after data is loaded and dimensions are set
        renderFrame(currentProjectionState);

        // Event listener for the toggle button (moved here to ensure data is ready)
        toggleButton.addEventListener('click', transformProjection);

    }).catch(error => {
        console.error("Error loading the world atlas data:", error);
    });

    // --- Responsive Resize Handler ---
    // Call updateDimensions on window resize
    window.addEventListener('resize', updateDimensions);
}
