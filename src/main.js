/**
 * GeodesicMapper: Interactive globe visualization that smoothly transitions between
 * orthographic (3D globe) and Mercator (2D map) projections.
 */

import * as d3 from 'd3';
import * as topojson from 'topojson-client';

const globeCanvasWrapper = d3.select("#globe-canvas-wrapper");
const globeCanvas = d3.select("#globe-canvas");
const globeContext = globeCanvas.node().getContext('2d');
const projectionToggleButton = document.getElementById('projection-toggle');


if (!globeCanvas.node() || !projectionToggleButton || !globeCanvasWrapper.node()) {
    console.error("Required DOM elements (canvas, toggle button, or canvas wrapper) not found!");
} else {
    let globeProjection;
    let projectionPath;
    let worldCountries = null;

    const ORTHOGRAPHIC_ROTATION = [10, -20, 0];
    let orthographicScale;
    const MERCATOR_ROTATION = [0, 0, 0];
    let mercatorScale;
    let mercatorTranslation;
    let mercatorViewportClipping = null;

    let zoom; // To handle zoom functionality
    let currentZoomTransform = d3.zoomIdentity;
    let initialCanvasSize = { width: 0, height: 0 };

    let projectionTransitionId = null;
    let isProjectionTransitioning = false;
    const PROJECTION_STATE = {
        ORTHOGRAPHIC: 0,
        MERCATOR: 1
    };
    let currentProjectionState = PROJECTION_STATE.ORTHOGRAPHIC;
    
    // Variables for handling rotation and dragging
    let isDragging = false;
    let dragStart = null;
    let currentRotation = [...ORTHOGRAPHIC_ROTATION];
    let mercatorOffset = 0; // Horizontal offset for Mercator projection
    
    // Variables for handling inertia
    let rotationVelocity = [0, 0];
    let mercatorVelocity = 0;
    let lastDragTime = null;
    let inertiaAnimationId = null;
    const FRICTION = 0.95; // Decay factor (0-1)
    const MIN_VELOCITY = 0.01; // Minimum velocity before stopping

    /**
     * Creates a custom projection that can smoothly interpolate between two different
     * map projections (e.g., orthographic to Mercator).
     * 
     * @param {Function} startProjection - Initial projection (e.g., orthographic for globe view)
     * @param {Function} endProjection - Target projection (e.g., Mercator for flat map)
     * @returns {Object} An interpolated projection with an alpha parameter to control transition
     */
    function createProjectionInterpolator(startProjection, endProjection) {
        const projectionMutator = d3.geoProjectionMutator(transitionProgress => (longitude, latitude) => {
            const [x0, y0] = startProjection(longitude, latitude);
            const [x1, y1] = endProjection(longitude, latitude);
            return [
                x0 + transitionProgress * (x1 - x0),
                y0 + transitionProgress * (y1 - y0)
            ];
        });
        let transitionProgress = 0;
        return Object.assign(projectionMutator(transitionProgress), {
            alpha(progress) {
                return arguments.length ? projectionMutator(transitionProgress = +progress) : transitionProgress;
            }
        });
    }

    const equatorLine = {
        type: "LineString",
        coordinates: [[-180, 0], [-90, 0], [0, 0], [90, 0], [180, 0]]
    };
    const globeSphere = { type: "Sphere" };
    const coordinateGrid = d3.geoGraticule10();
    const sampleTrajectoryLine = {
        type: "LineString",
        coordinates: [[-150, -60], [-75, -30], [0, 0], [75, 30], [150, 60]]
    };

    /**
     * Custom latitude bounds for Mercator projection to avoid extreme distortion
     * near the poles while maintaining a visually balanced map view.
     */
    const MERCATOR_LATITUDE_BOUNDS = {
        MIN: -83,
        MAX: 86
    };

    /**
     * Calculates the necessary parameters for the Mercator projection view including:
     * - Appropriate scale to fit the map within the canvas
     * - Translation to center the map
     * - Viewport clipping bounds to hide extreme polar distortions
     */
    function calculateMercatorViewportParameters() {
        const canvasWidth = +globeCanvas.attr("width");
        const canvasHeight = +globeCanvas.attr("height");

        const temporaryMercatorProjection = d3.geoMercator()
            .precision(0.1);

        mercatorScale = (Math.min(canvasWidth, canvasHeight)) / (2 * Math.PI);

        temporaryMercatorProjection.scale(mercatorScale)
                                   .translate([canvasWidth / 2, canvasHeight / 2]);

        const northernBoundaryY = temporaryMercatorProjection([0, MERCATOR_LATITUDE_BOUNDS.MAX])[1];
        const southernBoundaryY = temporaryMercatorProjection([0, MERCATOR_LATITUDE_BOUNDS.MIN])[1];

        const viewportHeight = southernBoundaryY - northernBoundaryY;
        const verticalCenteringOffset = (canvasHeight / 2) - (northernBoundaryY + viewportHeight / 2);

        mercatorTranslation = [canvasWidth / 2, verticalCenteringOffset + canvasHeight / 2];

        temporaryMercatorProjection.scale(mercatorScale).translate(mercatorTranslation);

        mercatorViewportClipping = {
            x: 0,
            y: Math.min(canvasWidth, temporaryMercatorProjection([0, MERCATOR_LATITUDE_BOUNDS.MAX])[1]),
            width: canvasWidth,
            height: temporaryMercatorProjection([0, MERCATOR_LATITUDE_BOUNDS.MIN])[1] - 
                   temporaryMercatorProjection([0, MERCATOR_LATITUDE_BOUNDS.MAX])[1]
        };
    }

    function handleCanvasResize() {
        const newCanvasWidth = globeCanvasWrapper.node().clientWidth;
        const newCanvasHeight = globeCanvasWrapper.node().clientHeight;

        if (initialCanvasSize.width === 0) {
            initialCanvasSize.width = newCanvasWidth;
            initialCanvasSize.height = newCanvasHeight;
        }

        if (+globeCanvas.attr("width") !== newCanvasWidth || +globeCanvas.attr("height") !== newCanvasHeight) {
            globeCanvas.attr("width", newCanvasWidth);
            globeCanvas.attr("height", newCanvasHeight);
            
            orthographicScale = Math.min(initialCanvasSize.width, initialCanvasSize.height) / 2 - 10;
            calculateMercatorViewportParameters();

            if (zoom) {
                currentZoomTransform = d3.zoomIdentity;
                d3.select(globeContext.canvas).call(zoom.transform, currentZoomTransform);
            }

            if (!globeProjection) {
                globeProjection = createProjectionInterpolator(d3.geoOrthographicRaw, d3.geoMercatorRaw)
                    .precision(0.1);
            }
            projectionPath = d3.geoPath(globeProjection, globeContext);

            globeProjection.scale(currentProjectionState === PROJECTION_STATE.ORTHOGRAPHIC ? orthographicScale : mercatorScale);
            globeProjection.translate(currentProjectionState === PROJECTION_STATE.ORTHOGRAPHIC ? 
                [newCanvasWidth / 2, newCanvasHeight / 2] : mercatorTranslation);
            globeProjection.rotate(currentProjectionState === PROJECTION_STATE.ORTHOGRAPHIC ? 
                ORTHOGRAPHIC_ROTATION : MERCATOR_ROTATION);

            if (worldCountries) {
                renderProjectionFrame(currentProjectionState);
            }
        }
    }

    /**
     * Renders a single frame of the globe/map visualization.
     * Handles the smooth transition between orthographic and Mercator projections by:
     * 1. Interpolating projection parameters (rotation, scale, translation)
     * 2. Applying appropriate clipping for different projection stages
     * 3. Rendering geographic features in the correct order
     * 
     * @param {number} transitionProgress - Value between 0 (orthographic) and 1 (Mercator)
     */
    function renderProjectionFrame(transitionProgress) {
        const canvasWidth = +globeCanvas.attr("width");
        const canvasHeight = +globeCanvas.attr("height");

        // When going from Mercator to orthographic, we need to calculate an initial rotation
        // that matches the current Mercator offset
        const startRotation = currentProjectionState === PROJECTION_STATE.MERCATOR ? 
            [(-mercatorOffset / mercatorScale) * (180 / Math.PI), 0, 0] : 
            currentRotation;

        const interpolatedRotation = d3.interpolate(
            startRotation,
            MERCATOR_ROTATION
        )(transitionProgress);
        const interpolatedScale = d3.interpolate(orthographicScale, mercatorScale)(transitionProgress);
        const interpolatedTranslation = d3.interpolate(
            [canvasWidth / 2, canvasHeight / 2], 
            mercatorTranslation
        )(transitionProgress);

        // Apply the Mercator horizontal offset during transition
        const interpolatedOffset = transitionProgress * mercatorOffset;
        const adjustedTranslation = [
            interpolatedTranslation[0] - interpolatedOffset,
            interpolatedTranslation[1]
        ];

        const zoomScale = (currentProjectionState === PROJECTION_STATE.ORTHOGRAPHIC && !isProjectionTransitioning) ? currentZoomTransform.k : 1;
        const finalScale = interpolatedScale * zoomScale;

        globeProjection
            .alpha(transitionProgress)
            .rotate(interpolatedRotation)
            .scale(finalScale)
            .translate(adjustedTranslation);

        globeContext.clearRect(0, 0, canvasWidth, canvasHeight);
        globeContext.save();

        if (transitionProgress > 0.5 && mercatorViewportClipping) {
            globeContext.beginPath();
            globeContext.rect(
                mercatorViewportClipping.x,
                mercatorViewportClipping.y,
                mercatorViewportClipping.width,
                mercatorViewportClipping.height
            );
            globeContext.clip();
        }

        // During the first half of the transition, we gradually expand the visible portion
        // of the globe from a hemisphere (90°) to a full sphere (180°) before switching to Mercator
        const HEMISPHERE_VIEW_THRESHOLD = 0.5;
        if (transitionProgress <= HEMISPHERE_VIEW_THRESHOLD) {
            const hemisphereExpansionAngle = 90 + (transitionProgress * 2) * 10;
            globeProjection.clipAngle(hemisphereExpansionAngle);
        } else {
            globeProjection.clipAngle(null);
        }

        if (worldCountries) {
            globeContext.beginPath();
            projectionPath(worldCountries);
            globeContext.fillStyle = "#336699";
            globeContext.fill();
            globeContext.lineWidth = 0.5;
            globeContext.strokeStyle = "#ffffff";
            globeContext.stroke();
        }

        const cartographicElementsClipAngle = transitionProgress <= HEMISPHERE_VIEW_THRESHOLD ?
            90 + (transitionProgress * 2) * 90 : 
            180;
        globeProjection.clipAngle(cartographicElementsClipAngle);


        globeContext.beginPath();
        projectionPath(coordinateGrid);
        globeContext.lineWidth = 0.5;
        globeContext.strokeStyle = "rgba(255, 255, 255, 0.2)";
        globeContext.stroke();

        globeContext.beginPath();
        projectionPath(globeSphere);
        globeContext.lineWidth = 1.5;
        globeContext.strokeStyle = "#fff";
        globeContext.stroke();

        globeContext.beginPath();
        projectionPath(equatorLine);
        globeContext.lineWidth = 2;
        globeContext.strokeStyle = "#ff4444";
        globeContext.stroke();

        globeContext.beginPath();
        projectionPath(sampleTrajectoryLine);
        globeContext.lineWidth = 2;
        globeContext.strokeStyle = "#00FF00";
        globeContext.stroke();

        globeContext.restore();
    }

    /**
     * Manages the animated transition between projection states using requestAnimationFrame.
     * Applies easing for smooth acceleration and deceleration of the transition.
     * 
     * @param {number} targetProjectionState - The projection state to transition to (ORTHOGRAPHIC or MERCATOR)
     */
    function animateProjectionTransition(targetProjectionState) {
        if (isProjectionTransitioning) return;
        
        isProjectionTransitioning = true;
        projectionToggleButton.disabled = true;

        // When transitioning from Mercator to orthographic, set initial rotation
        if (currentProjectionState === PROJECTION_STATE.MERCATOR && 
            targetProjectionState === PROJECTION_STATE.ORTHOGRAPHIC) {
            currentRotation = [(-mercatorOffset / mercatorScale) * (180 / Math.PI), 0, 0];
        }

        const TRANSITION_DURATION = 1500;
        const transitionEasing = d3.easeCubicInOut;
        let transitionStartTime = null;

        const initialState = currentProjectionState;
        const finalState = targetProjectionState;

        function transitionFrame(timestamp) {
            if (!transitionStartTime) transitionStartTime = timestamp;
            const elapsedTime = timestamp - transitionStartTime;
            const normalizedProgress = Math.min(1, elapsedTime / TRANSITION_DURATION);

            const transitionProgress = initialState + 
                (finalState - initialState) * transitionEasing(normalizedProgress);

            renderProjectionFrame(transitionProgress);

            if (elapsedTime < TRANSITION_DURATION) {
                projectionTransitionId = requestAnimationFrame(transitionFrame);
            } else {
                isProjectionTransitioning = false;
                projectionToggleButton.disabled = false;
                currentProjectionState = targetProjectionState;
                if (currentProjectionState === PROJECTION_STATE.MERCATOR) {
                    currentZoomTransform = d3.zoomIdentity;
                    d3.select(globeContext.canvas).call(zoom.transform, d3.zoomIdentity);
                }
                renderProjectionFrame(targetProjectionState);
            }
        }
        projectionTransitionId = requestAnimationFrame(transitionFrame);
    }

    function toggleProjectionType() {
        if (isProjectionTransitioning) return;

        const targetState = currentProjectionState === PROJECTION_STATE.ORTHOGRAPHIC ? 
            PROJECTION_STATE.MERCATOR : 
            PROJECTION_STATE.ORTHOGRAPHIC;
        
        animateProjectionTransition(targetState);
    }

    /**
     * Check if a point is within the visible area of the current projection
     */
    function isPointInVisibleArea(x, y) {
        // For Mercator projection after transition midpoint
        if (currentProjectionState === PROJECTION_STATE.MERCATOR || 
            (isProjectionTransitioning && globeProjection.alpha() > 0.5)) {
            if (!mercatorViewportClipping) return false;
            
            // For Mercator, calculate the actual map width based on the scale
            const canvasWidth = +globeCanvas.attr("width");
            const mapWidth = mercatorScale * 2 * Math.PI; // Full map width at current scale
            const horizontalPadding = (canvasWidth - mapWidth) / 2;
            
            // Check both vertical and horizontal bounds
            const inVerticalBounds = y >= mercatorViewportClipping.y && 
                                   y <= mercatorViewportClipping.y + mercatorViewportClipping.height;
            const inHorizontalBounds = x >= horizontalPadding && x <= canvasWidth - horizontalPadding;
            
            return inVerticalBounds && inHorizontalBounds;
        }
        
        // For orthographic projection, check if point is within the visible hemisphere
        const canvasWidth = +globeCanvas.attr("width");
        const canvasHeight = +globeCanvas.attr("height");
        const centerX = canvasWidth / 2;
        const centerY = canvasHeight / 2;
        const dx = x - centerX;
        const dy = y - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        return distance <= orthographicScale * currentZoomTransform.k;
    }

    /**
     * Handle mouse movement to update cursor style and handle rotation
     */
    /**
     * Convert screen coordinates to spherical coordinates (longitude, latitude)
     * @param {number} x - Screen x coordinate
     * @param {number} y - Screen y coordinate
     * @returns {[number, number]} [longitude, latitude] in degrees, or null if not on sphere
     */
    function screenToSphere(x, y) {
        const canvasWidth = +globeCanvas.attr("width");
        const canvasHeight = +globeCanvas.attr("height");
        const centerX = canvasWidth / 2;
        const centerY = canvasHeight / 2;

        const currentScale = orthographicScale * currentZoomTransform.k;

        // Convert to normalized device coordinates (-1 to 1)
        const nx = (x - centerX) / currentScale;
        const ny = (y - centerY) / currentScale;

        // Check if point is on sphere
        const r2 = nx * nx + ny * ny;
        if (r2 > 1) return null;

        // Convert to latitude and longitude
        const r = Math.sqrt(r2);
        const c = Math.asin(r); // Central angle
        const sin_c = Math.sin(c);
        const cos_c = Math.cos(c);

        const rotation = globeProjection.rotate();
        const R = d3.geoRotation(rotation);
        const p_inv = R.invert([x,y]);

        const lambda = p_inv[0] * Math.PI / 180;
        const phi = p_inv[1] * Math.PI / 180;

        const longitude = Math.atan2(nx * sin_c, r * cos_c) * 180 / Math.PI;
        const latitude = (r === 0) ? Math.asin(ny * sin_c / 1) * 180 / Math.PI : Math.asin(ny * sin_c / r) * 180 / Math.PI;

        return [longitude, latitude];
    }

    /**
     * Apply inertia to continue rotation after dragging
     */
    function applyInertia() {
        if (currentProjectionState === PROJECTION_STATE.ORTHOGRAPHIC) {
            if (Math.abs(rotationVelocity[0]) < MIN_VELOCITY && Math.abs(rotationVelocity[1]) < MIN_VELOCITY) {
                cancelAnimationFrame(inertiaAnimationId);
                inertiaAnimationId = null;
                return;
            }

            // Apply velocity to rotation
            currentRotation[0] += rotationVelocity[0];
            currentRotation[1] += rotationVelocity[1];

            // Apply friction
            rotationVelocity[0] *= FRICTION;
            rotationVelocity[1] *= FRICTION;
        } else {
            if (Math.abs(mercatorVelocity) < MIN_VELOCITY) {
                cancelAnimationFrame(inertiaAnimationId);
                inertiaAnimationId = null;
                return;
            }

            // Apply velocity to mercator offset
            mercatorOffset += mercatorVelocity;
            
            // Wrap around when crossing bounds
            const fullWidth = mercatorScale * 2 * Math.PI;
            mercatorOffset = ((mercatorOffset % fullWidth) + fullWidth) % fullWidth;
            
            // Apply friction
            mercatorVelocity *= FRICTION;
        }

        renderProjectionFrame(currentProjectionState);
        inertiaAnimationId = requestAnimationFrame(applyInertia);
    }

    function handleMouseMove(event) {
        const rect = globeCanvas.node().getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        if (isDragging) {
            // If mouse goes out of bounds, stop dragging and start inertia
            if (!isPointInVisibleArea(x, y)) {
                isDragging = false;
                dragStart = null;
                if (currentProjectionState === PROJECTION_STATE.ORTHOGRAPHIC && (Math.abs(rotationVelocity[0]) > MIN_VELOCITY || Math.abs(rotationVelocity[1]) > MIN_VELOCITY)) {
                    if (inertiaAnimationId === null) {
                        applyInertia();
                    }
                }
                globeCanvas.node().style.cursor = 'default';
                return;
            }

            const currentTime = performance.now();
            
            if (currentProjectionState === PROJECTION_STATE.ORTHOGRAPHIC) {
                const dx = event.clientX - dragStart[0];
                const dy = event.clientY - dragStart[1];

                const sensitivity = 0.25; // Keep sensitivity constant
                const rotation = globeProjection.rotate();
                const k = sensitivity / (globeProjection.scale() / orthographicScale);

                const newRotation = [
                    rotation[0] + dx * k,
                    rotation[1] - dy * k,
                    rotation[2]
                ];
                
                currentRotation = newRotation;
                globeProjection.rotate(newRotation);


                if (lastDragTime) {
                    const dt = currentTime - lastDragTime;
                    if (dt > 0) {
                        rotationVelocity[0] = (dx * k) / dt * 16;
                        rotationVelocity[1] = (-dy * k) / dt * 16;
                    }
                }
            } else {
                // Handle Mercator projection dragging
                const dx = event.clientX - dragStart[0];
                mercatorOffset -= dx;
                
                // Calculate velocity for mercator scrolling
                if (lastDragTime) {
                    const dt = currentTime - lastDragTime;
                    mercatorVelocity = -dx / dt * 16;
                }
            }
            
            lastDragTime = currentTime;
            dragStart = [event.clientX, event.clientY];
            renderProjectionFrame(currentProjectionState);
        } else {
            if (isPointInVisibleArea(x, y)) {
                globeCanvas.node().style.cursor = 'grab';
            } else {
                globeCanvas.node().style.cursor = 'default';
            }
        }
    }

    /**
     * Handle mouse down event
     */
    function handleMouseDown(event) {
        const rect = globeCanvas.node().getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        if (isPointInVisibleArea(x, y) && currentProjectionState === PROJECTION_STATE.ORTHOGRAPHIC) {
            isDragging = true;
            dragStart = [event.clientX, event.clientY];
            lastDragTime = performance.now();
            globeCanvas.node().style.cursor = 'grabbing';
            if (inertiaAnimationId) {
                cancelAnimationFrame(inertiaAnimationId);
                inertiaAnimationId = null;
            }
            rotationVelocity = [0, 0]; // Reset velocity on new drag
        }
    }

    /**
     * Handle mouse up event
     */
    function handleMouseUp(event) {
        if (isDragging) {
            isDragging = false;
            dragStart = null;
            
            const rect = globeCanvas.node().getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            
            if (isPointInVisibleArea(x, y)) {
                globeCanvas.node().style.cursor = 'grab';
            }
            
            // Start inertia animation if we have velocity
            if (currentProjectionState === PROJECTION_STATE.ORTHOGRAPHIC &&
                (Math.abs(rotationVelocity[0]) > MIN_VELOCITY || Math.abs(rotationVelocity[1]) > MIN_VELOCITY)) {
                if (inertiaAnimationId === null) {
                    applyInertia(); // Start the animation
                }
            }
        }
    }

    // Initialize the visualization by loading world map data, setting up the canvas,
    // and establishing event listeners for user interaction
    d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json").then(worldAtlasData => {
        worldCountries = topojson.feature(worldAtlasData, worldAtlasData.objects.countries);
        handleCanvasResize();
        renderProjectionFrame(currentProjectionState);
        projectionToggleButton.addEventListener('click', toggleProjectionType);
        
        // Add mouse event listeners for cursor handling
        globeCanvas.node().addEventListener('mousemove', handleMouseMove);
        globeCanvas.node().addEventListener('mousedown', handleMouseDown);
        globeCanvas.node().addEventListener('mouseup', handleMouseUp);
        globeCanvas.node().addEventListener('mouseout', handleMouseUp); // Stop dragging if mouse leaves canvas

        zoom = d3.zoom()
            .scaleExtent([0.8, 10])
            .filter(event => {
                // Only allow wheel events for zooming.
                // This prevents d3.zoom from interfering with drag-to-rotate.
                return event.type === 'wheel';
            })
            .on('zoom', (event) => {
                if (currentProjectionState === PROJECTION_STATE.ORTHOGRAPHIC && !isProjectionTransitioning) {
                    currentZoomTransform = event.transform;
                    renderProjectionFrame(currentProjectionState);
                }
            });
        d3.select(globeContext.canvas).call(zoom);

    }).catch(error => {
        console.error("Error loading the world atlas data:", error);
    });

    window.addEventListener('resize', handleCanvasResize);
}
