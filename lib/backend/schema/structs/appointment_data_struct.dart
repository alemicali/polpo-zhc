// ignore_for_file: unnecessary_getters_setters
import '/backend/algolia/serialization_util.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class AppointmentDataStruct extends FFFirebaseStruct {
  AppointmentDataStruct({
    DateTime? date,
    DocumentReference? appointmentRef,
    List<WorkerDataStruct>? workerData,
    DateTime? startDate,
    FirestoreUtilData firestoreUtilData = const FirestoreUtilData(),
  })  : _date = date,
        _appointmentRef = appointmentRef,
        _workerData = workerData,
        _startDate = startDate,
        super(firestoreUtilData);

  // "date" field.
  DateTime? _date;
  DateTime? get date => _date;
  set date(DateTime? val) => _date = val;

  bool hasDate() => _date != null;

  // "appointment_ref" field.
  DocumentReference? _appointmentRef;
  DocumentReference? get appointmentRef => _appointmentRef;
  set appointmentRef(DocumentReference? val) => _appointmentRef = val;

  bool hasAppointmentRef() => _appointmentRef != null;

  // "workerData" field.
  List<WorkerDataStruct>? _workerData;
  List<WorkerDataStruct> get workerData => _workerData ?? const [];
  set workerData(List<WorkerDataStruct>? val) => _workerData = val;

  void updateWorkerData(Function(List<WorkerDataStruct>) updateFn) {
    updateFn(_workerData ??= []);
  }

  bool hasWorkerData() => _workerData != null;

  // "startDate" field.
  DateTime? _startDate;
  DateTime? get startDate => _startDate;
  set startDate(DateTime? val) => _startDate = val;

  bool hasStartDate() => _startDate != null;

  static AppointmentDataStruct fromMap(Map<String, dynamic> data) =>
      AppointmentDataStruct(
        date: data['date'] as DateTime?,
        appointmentRef: data['appointment_ref'] as DocumentReference?,
        workerData: getStructList(
          data['workerData'],
          WorkerDataStruct.fromMap,
        ),
        startDate: data['startDate'] as DateTime?,
      );

  static AppointmentDataStruct? maybeFromMap(dynamic data) => data is Map
      ? AppointmentDataStruct.fromMap(data.cast<String, dynamic>())
      : null;

  Map<String, dynamic> toMap() => {
        'date': _date,
        'appointment_ref': _appointmentRef,
        'workerData': _workerData?.map((e) => e.toMap()).toList(),
        'startDate': _startDate,
      }.withoutNulls;

  @override
  Map<String, dynamic> toSerializableMap() => {
        'date': serializeParam(
          _date,
          ParamType.DateTime,
        ),
        'appointment_ref': serializeParam(
          _appointmentRef,
          ParamType.DocumentReference,
        ),
        'workerData': serializeParam(
          _workerData,
          ParamType.DataStruct,
          isList: true,
        ),
        'startDate': serializeParam(
          _startDate,
          ParamType.DateTime,
        ),
      }.withoutNulls;

  static AppointmentDataStruct fromSerializableMap(Map<String, dynamic> data) =>
      AppointmentDataStruct(
        date: deserializeParam(
          data['date'],
          ParamType.DateTime,
          false,
        ),
        appointmentRef: deserializeParam(
          data['appointment_ref'],
          ParamType.DocumentReference,
          false,
          collectionNamePath: ['appointments'],
        ),
        workerData: deserializeStructParam<WorkerDataStruct>(
          data['workerData'],
          ParamType.DataStruct,
          true,
          structBuilder: WorkerDataStruct.fromSerializableMap,
        ),
        startDate: deserializeParam(
          data['startDate'],
          ParamType.DateTime,
          false,
        ),
      );

  static AppointmentDataStruct fromAlgoliaData(Map<String, dynamic> data) =>
      AppointmentDataStruct(
        date: convertAlgoliaParam(
          data['date'],
          ParamType.DateTime,
          false,
        ),
        appointmentRef: convertAlgoliaParam(
          data['appointment_ref'],
          ParamType.DocumentReference,
          false,
        ),
        workerData: convertAlgoliaParam<WorkerDataStruct>(
          data['workerData'],
          ParamType.DataStruct,
          true,
          structBuilder: WorkerDataStruct.fromAlgoliaData,
        ),
        startDate: convertAlgoliaParam(
          data['startDate'],
          ParamType.DateTime,
          false,
        ),
        firestoreUtilData: FirestoreUtilData(
          clearUnsetFields: false,
          create: true,
        ),
      );

  @override
  String toString() => 'AppointmentDataStruct(${toMap()})';

  @override
  bool operator ==(Object other) {
    const listEquality = ListEquality();
    return other is AppointmentDataStruct &&
        date == other.date &&
        appointmentRef == other.appointmentRef &&
        listEquality.equals(workerData, other.workerData) &&
        startDate == other.startDate;
  }

  @override
  int get hashCode =>
      const ListEquality().hash([date, appointmentRef, workerData, startDate]);
}

AppointmentDataStruct createAppointmentDataStruct({
  DateTime? date,
  DocumentReference? appointmentRef,
  DateTime? startDate,
  Map<String, dynamic> fieldValues = const {},
  bool clearUnsetFields = true,
  bool create = false,
  bool delete = false,
}) =>
    AppointmentDataStruct(
      date: date,
      appointmentRef: appointmentRef,
      startDate: startDate,
      firestoreUtilData: FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
        delete: delete,
        fieldValues: fieldValues,
      ),
    );

AppointmentDataStruct? updateAppointmentDataStruct(
  AppointmentDataStruct? appointmentData, {
  bool clearUnsetFields = true,
  bool create = false,
}) =>
    appointmentData
      ?..firestoreUtilData = FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
      );

void addAppointmentDataStructData(
  Map<String, dynamic> firestoreData,
  AppointmentDataStruct? appointmentData,
  String fieldName, [
  bool forFieldValue = false,
]) {
  firestoreData.remove(fieldName);
  if (appointmentData == null) {
    return;
  }
  if (appointmentData.firestoreUtilData.delete) {
    firestoreData[fieldName] = FieldValue.delete();
    return;
  }
  final clearFields =
      !forFieldValue && appointmentData.firestoreUtilData.clearUnsetFields;
  if (clearFields) {
    firestoreData[fieldName] = <String, dynamic>{};
  }
  final appointmentDataData =
      getAppointmentDataFirestoreData(appointmentData, forFieldValue);
  final nestedData =
      appointmentDataData.map((k, v) => MapEntry('$fieldName.$k', v));

  final mergeFields = appointmentData.firestoreUtilData.create || clearFields;
  firestoreData
      .addAll(mergeFields ? mergeNestedFields(nestedData) : nestedData);
}

Map<String, dynamic> getAppointmentDataFirestoreData(
  AppointmentDataStruct? appointmentData, [
  bool forFieldValue = false,
]) {
  if (appointmentData == null) {
    return {};
  }
  final firestoreData = mapToFirestore(appointmentData.toMap());

  // Add any Firestore field values
  appointmentData.firestoreUtilData.fieldValues
      .forEach((k, v) => firestoreData[k] = v);

  return forFieldValue ? mergeNestedFields(firestoreData) : firestoreData;
}

List<Map<String, dynamic>> getAppointmentDataListFirestoreData(
  List<AppointmentDataStruct>? appointmentDatas,
) =>
    appointmentDatas
        ?.map((e) => getAppointmentDataFirestoreData(e, true))
        .toList() ??
    [];
