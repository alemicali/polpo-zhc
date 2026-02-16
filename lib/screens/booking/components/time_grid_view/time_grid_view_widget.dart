import '/backend/backend.dart';
import '/flutter_flow/flutter_flow_theme.dart';
import '/flutter_flow/flutter_flow_util.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'time_grid_view_model.dart';
export 'time_grid_view_model.dart';

class TimeGridViewWidget extends StatefulWidget {
  const TimeGridViewWidget({
    super.key,
    required this.appointments,
    required this.workers,
    required this.selectedDate,
    this.currentWorker,
    this.onAppointmentTap,
    this.onEmptyCellTap,
  });

  final List<AppointmentsRecord> appointments;
  final List<WorkersRecord> workers;
  final DateTime selectedDate;
  final WorkersRecord? currentWorker;
  final Function(AppointmentsRecord)? onAppointmentTap;
  final Function(DateTime)? onEmptyCellTap;

  @override
  State<TimeGridViewWidget> createState() => _TimeGridViewWidgetState();
}

class _TimeGridViewWidgetState extends State<TimeGridViewWidget> {
  late TimeGridViewModel _model;

  // Responsive dimensions
  late double pixelsPerMinute;
  late double hourRowHeight;
  late double timeColumnWidth;
  late double workerColumnWidth;
  late double headerHeight;

  final int startHour = 8;
  final int endHour = 19;

  @override
  void initState() {
    super.initState();
    _model = createModel(context, () => TimeGridViewModel());
  }

  void _updateDimensions() {
    final screenWidth = MediaQuery.of(context).size.width;
    final isDesktop = screenWidth > 1200;
    final isTablet = screenWidth > 600 && screenWidth <= 1200;

    if (isDesktop) {
      pixelsPerMinute = 1.0; // 30 min = 30px
      hourRowHeight = 120.0;
      timeColumnWidth = 80.0;
      workerColumnWidth = 220.0;
      headerHeight = 50.0;
    } else if (isTablet) {
      pixelsPerMinute = 0.7;
      hourRowHeight = 80.0;
      timeColumnWidth = 70.0;
      workerColumnWidth = 160.0;
      headerHeight = 45.0;
    } else {
      // Mobile
      pixelsPerMinute = 0.5;
      hourRowHeight = 60.0;
      timeColumnWidth = 60.0;
      workerColumnWidth = 140.0;
      headerHeight = 40.0;
    }
  }

  @override
  void dispose() {
    _model.dispose();
    super.dispose();
  }

  Color _getColorForService(String? serviceName) {
    // Usa colori del tema BF + colori sofisticati per i servizi
    final colors = {
      'Massaggio': const Color(0xFF6B8E77), // Verde naturale
      'Trattamento viso': const Color(0xFFB8A6D4), // Lavanda
      'Manicure': const Color(0xFFE8B4C8), // Rosa polvere
      'Pedicure': const Color(0xFFFFC26F), // Arancione tema
      'Estetica': const Color(0xFFD4A574), // Beige caldo
      'Scrub': const Color(0xFF9BB6C4), // Blu-grigio
      'Sauna': const Color(0xFF8B7355), // Marrone naturale
      'Relax': const Color(0xFFCE9FB8), // Rosa sofisticato
    };
    // Default: usa accent1 del tema BF
    return colors[serviceName] ?? FlutterFlowTheme.of(context).accent1;
  }

  List<Widget> _buildTimeLabels() {
    List<Widget> labels = [];

    // Header
    labels.add(
      Container(
        height: headerHeight,
        width: timeColumnWidth,
        decoration: BoxDecoration(
          color: FlutterFlowTheme.of(context).primaryBackground,
          border: Border(
            bottom: BorderSide(
              color: FlutterFlowTheme.of(context).alternate,
              width: 2,
            ),
            right: BorderSide(
              color: FlutterFlowTheme.of(context).alternate,
              width: 1,
            ),
          ),
        ),
        child: Center(
          child: Text(
            'Orario',
            style: GoogleFonts.dmSans(
              textStyle: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: FlutterFlowTheme.of(context).primaryText,
              ),
            ),
          ),
        ),
      ),
    );

    // Time labels
    for (int hour = startHour; hour < endHour; hour++) {
      labels.add(
        Container(
          height: hourRowHeight,
          width: timeColumnWidth,
          decoration: BoxDecoration(
            border: Border(
              bottom: BorderSide(
                color: FlutterFlowTheme.of(context).alternate,
                width: 1,
              ),
              right: BorderSide(
                color: FlutterFlowTheme.of(context).alternate,
                width: 1,
              ),
            ),
          ),
          child: Center(
            child: Text(
              '${hour.toString().padLeft(2, '0')}:00',
              style: GoogleFonts.dmSans(
                textStyle: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w500,
                  color: FlutterFlowTheme.of(context).secondaryText,
                ),
              ),
            ),
          ),
        ),
      );
    }

    return labels;
  }

  Widget _buildCurrentWorkerColumn(WorkersRecord worker) {
    List<AppointmentsRecord> workerAppointments = widget.appointments
        .where((apt) => apt.workers.contains(worker.reference))
        .toList();

    final gridHeight = (endHour - startHour) * hourRowHeight;

    return Column(
      children: [
        // Header: worker name (highlighted)
        Container(
          width: workerColumnWidth,
          height: headerHeight,
          decoration: BoxDecoration(
            color: FlutterFlowTheme.of(context).accent1,
            border: Border(
              bottom: BorderSide(
                color: FlutterFlowTheme.of(context).accent1,
                width: 2,
              ),
              right: BorderSide(
                color: FlutterFlowTheme.of(context).alternate,
                width: 1,
              ),
            ),
          ),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    worker.name ?? 'Operatore',
                    style: GoogleFonts.dmSans(
                      textStyle: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: Colors.white,
                      ),
                    ),
                    textAlign: TextAlign.center,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    '(Tu)',
                    style: GoogleFonts.dmSans(
                      textStyle: TextStyle(
                        fontSize: 9,
                        fontWeight: FontWeight.w400,
                        color: Colors.white.withValues(alpha: 0.8),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        // Grid with time slots
        SizedBox(
          width: workerColumnWidth,
          height: gridHeight,
          child: Stack(
            children: [
              // Background grid lines
              _buildGridLines(),
              // Appointment blocks
              ..._buildAppointmentBlocks(workerAppointments, worker),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildWorkerColumn(WorkersRecord worker) {
    List<AppointmentsRecord> workerAppointments = widget.appointments
        .where((apt) => apt.workers.contains(worker.reference))
        .toList();

    final gridHeight = (endHour - startHour) * hourRowHeight;

    return Column(
      children: [
        // Header: worker name
        Container(
          width: workerColumnWidth,
          height: headerHeight,
          decoration: BoxDecoration(
            color: FlutterFlowTheme.of(context).primaryBackground,
            border: Border(
              bottom: BorderSide(
                color: FlutterFlowTheme.of(context).alternate,
                width: 2,
              ),
              right: BorderSide(
                color: FlutterFlowTheme.of(context).alternate,
                width: 1,
              ),
            ),
          ),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Text(
                worker.name ?? 'Operatore',
                style: GoogleFonts.dmSans(
                  textStyle: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: FlutterFlowTheme.of(context).accent1,
                  ),
                ),
                textAlign: TextAlign.center,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
        ),
        // Grid with time slots
        SizedBox(
          width: workerColumnWidth,
          height: gridHeight,
          child: Stack(
            children: [
              // Background grid lines
              _buildGridLines(),
              // Appointment blocks
              ..._buildAppointmentBlocks(workerAppointments, worker),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildGridLines() {
    return Column(
      children: List.generate(
        (endHour - startHour),
        (index) => Container(
          height: hourRowHeight,
          width: workerColumnWidth,
          decoration: BoxDecoration(
            border: Border(
              right: BorderSide(
                color: FlutterFlowTheme.of(context).alternate,
                width: 1,
              ),
              bottom: BorderSide(
                color: FlutterFlowTheme.of(context).alternate,
                width: 1,
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<Positioned> _buildAppointmentBlocks(
    List<AppointmentsRecord> appointments,
    WorkersRecord worker,
  ) {
    return appointments
        .where((apt) => apt.startDate != null)
        .map((apt) {
      // Calculate position
      double top = (apt.startDate!.hour - startHour) * hourRowHeight +
          apt.startDate!.minute * pixelsPerMinute;
      double height = apt.duration * pixelsPerMinute;

      // Ensure minimum height for visibility
      if (height < 25) height = 25;

      Color blockColor = _getColorForService(apt.serviceData.name);
      String clientName = apt.clientData.name ?? 'Cliente';
      String timeStr =
          '${apt.startDate!.hour.toString().padLeft(2, '0')}:${apt.startDate!.minute.toString().padLeft(2, '0')}';

      return Positioned(
        top: top,
        left: 3,
        right: 3,
        height: height,
        child: GestureDetector(
          onTap: () {
            if (widget.onAppointmentTap != null) {
              widget.onAppointmentTap!(apt);
            }
          },
          child: Container(
            decoration: BoxDecoration(
              color: blockColor,
              borderRadius: BorderRadius.circular(6),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.1),
                  offset: const Offset(0, 2),
                  blurRadius: 4,
                ),
              ],
              border: Border.all(
                color: blockColor.withValues(alpha: 0.3),
                width: 1,
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.all(4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Client name
                  Flexible(
                    child: Text(
                      clientName,
                      style: GoogleFonts.dmSans(
                        textStyle: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: Colors.white,
                          height: 1.2,
                        ),
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  // Time
                  if (height > 30)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        timeStr,
                        style: GoogleFonts.dmSans(
                          textStyle: TextStyle(
                            fontSize: 9,
                            fontWeight: FontWeight.w400,
                            color: Colors.white.withValues(alpha: 0.9),
                            height: 1.1,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      );
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    _updateDimensions();

    return Container(
      color: FlutterFlowTheme.of(context).secondaryBackground,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header con data
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(24, 16, 24, 16),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Griglia Oraria',
                      style: FlutterFlowTheme.of(context).titleMedium.override(
                            font: GoogleFonts.dmSans(
                              fontWeight: FontWeight.w600,
                            ),
                            color:
                                FlutterFlowTheme.of(context).primaryText,
                          ),
                    ),
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        DateFormat('EEEE, dd MMMM yyyy', 'it_IT')
                            .format(widget.selectedDate),
                        style:
                            FlutterFlowTheme.of(context).bodySmall
                                .override(
                              color: FlutterFlowTheme.of(context)
                                  .secondaryText,
                            ),
                      ),
                    ),
                  ],
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: FlutterFlowTheme.of(context).primaryBackground,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: FlutterFlowTheme.of(context).alternate,
                      width: 1,
                    ),
                  ),
                  child: Text(
                    '${widget.workers.length} operatori',
                    style: GoogleFonts.dmSans(
                      textStyle: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w500,
                        color:
                            FlutterFlowTheme.of(context).secondaryText,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          // Divider
          Divider(
            height: 1,
            thickness: 1,
            color: FlutterFlowTheme.of(context).alternate,
          ),
          // Grid - Fullscreen
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SingleChildScrollView(
                scrollDirection: Axis.vertical,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Time column
                    Column(
                      children: _buildTimeLabels(),
                    ),
                    // Current user worker column (highlighted)
                    if (widget.currentWorker != null)
                      _buildCurrentWorkerColumn(widget.currentWorker!),
                    // Other worker columns
                    ...widget.workers.map((worker) {
                      return _buildWorkerColumn(worker);
                    }).toList(),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
